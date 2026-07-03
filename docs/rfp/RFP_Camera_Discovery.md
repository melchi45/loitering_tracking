# RFP — Camera Discovery & Network Search Subsystem
**Document ID**: LTS-2026-002  
**Version**: 1.6  
**Date**: 2026-07-03  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Discovery Protocols](#2-discovery-protocols)
   - 2.1 [WiseNet UDP Discovery (Proprietary)](#21-wisenet-udp-discovery-proprietary)
   - 2.2 [ONVIF WS-Discovery (Standard)](#22-onvif-ws-discovery-standard)
3. [Functional Requirements](#3-functional-requirements)
4. [System Architecture](#4-system-architecture)
5. [API Specification](#5-api-specification)
6. [Device Information Model](#6-device-information-model)
7. [Implementation Status](#7-implementation-status)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Glossary](#9-glossary)

---

## 1. Overview

The Camera Discovery subsystem enables the LTS server to automatically locate IP cameras on the local network without manual IP address entry. Discovered cameras are presented to the operator in real time through the dashboard UI, where they can be reviewed and added to the monitoring pipeline with a single click.

The subsystem must support two parallel discovery mechanisms:

| Mechanism | Scope | Standard |
|---|---|---|
| **WiseNet UDP Discovery** | Hanwha / WiseNet cameras | Proprietary (Samsung/Hanwha) |
| **ONVIF WS-Discovery** | All ONVIF-compliant cameras | ONVIF Core 2.x / WS-Discovery |

Both mechanisms run concurrently and merge results into a single unified device list deduplicated by MAC address.

---

## 2. Discovery Protocols

### 2.1 WiseNet UDP Discovery (Proprietary)

#### 2.1.1 Protocol Description

WiseNet UDP Discovery is the proprietary network search protocol used by Hanwha Vision (formerly Samsung Techwin) cameras. It is reverse-engineered from the **WiseNetChromeIPInstaller** Chrome extension and operates as follows:

| Parameter | Value |
|---|---|
| Transport | UDP (IPv4) |
| Send port | **7701** |
| Receive port | **7711** |
| Destination | Broadcast (`255.255.255.255`) |
| Trigger | Single fixed-length magic packet (160 bytes) |
| Response | Binary-encoded camera info record |
| Timeout | 8 seconds per scan |

#### 2.1.2 Discovery Packet

The client sends a fixed 160-byte magic packet to UDP port 7701. Cameras listening on the broadcast address respond on port 7711 with a binary record containing device metadata.

```
Discovery Packet (hex, 160 bytes):
018750735306465625ef6da75b047d7bcd1c3c001800000000000000f0eacf00
000000000000000000000000faf8ec76000000000000000050ea18001a01ec76
...
```

#### 2.1.3 Response Packet Format

Each camera response contains the following binary-encoded fields. Fields marked *(if len ≥ 261)* are only present in extended-format responses.

| Field | Size (bytes) | Type | Description |
|---|---|---|---|
| `nMode` | 1 | uint8 | Packet mode |
| `chPacketId` | 18 | bytes | Packet identifier |
| `chMac` | 18 | string | MAC address |
| `chIP` | 16 | string | IP address |
| `chSubnetMask` | 16 | string | Subnet mask |
| `chGateway` | 16 | string | Default gateway |
| `chPassword` | 20 | string | Password |
| `isSupportSunapi` | 1 | uint8 | SUNAPI support flag |
| `nPort` | 2 | uint16 BE | Device port |
| `nStatus` | 1 | uint8 | Device status |
| `chDeviceName` | 10 | string | Device name (short, legacy) |
| `Reserved2` | 1 | bytes | Reserved |
| `nHttpPort` | 2 | uint16 BE | HTTP port |
| `nDevicePort` | 2 | uint16 BE | Device port |
| `nTcpPort` | 2 | uint16 BE | TCP port |
| `nUdpPort` | 2 | uint16 BE | UDP port |
| `nUploadPort` | 2 | uint16 BE | Upload port |
| `nMulticastPort` | 2 | uint16 BE | Multicast port |
| `nNetworkMode` | 1 | uint8 | Network mode |
| `DDNSURL` | 128 | string | DDNS URL |
| `alias` | 32 | string | Camera alias *(if len ≥ 261)* |
| `chDeviceNameNew` | 32 | string | Device name (current) *(if len ≥ 261)* |
| `modelType` | 1 | uint8 | Model type *(if len ≥ 261)* |
| `version` | 2 | uint16 | Firmware version *(if len ≥ 261)* |
| `httpType` | 1 | uint8 | 0=HTTP, 1=HTTPS *(if len ≥ 261)* |
| `Reserved3` | 1 | bytes | Reserved *(if len ≥ 261)* |
| `nHttpsPort` | 2 | uint16 BE | HTTPS port *(if len ≥ 261)* |
| `noPassword` | 1 | uint8 | No-password flag *(if len ≥ 261)* |

#### 2.1.4 Current Implementation

- **Source**: `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`
- **Service**: `server/src/services/discoveryService.js`
- **Mode**: Continuous background scanning (8s scan + 2s pause, repeating)
- **Deduplication**: MAC address based, persists across scan cycles
- **Real-time push**: Socket.IO `discovery:result` event per new/updated device

**Submodule structure** (branch: `nodejs-udp-discovery`):

```
submodules/WiseNetChromeIPInstaller/
└── nodejs/
    ├── udpDiscovery.js     # Core discovery module (dgram port)
    ├── utils.js            # ntohs/ntohl/bytes2int helpers
    └── index.js            # Example usage / CLI
```

**Usage example:**

```javascript
const { UDPDiscovery } = require('./submodules/WiseNetChromeIPInstaller/nodejs');

const discovery = new UDPDiscovery();
discovery.on('device', (camera) => {
  console.log(`Found: ${camera.chDeviceName} @ ${camera.chIP}:${camera.nHttpPort}`);
  // { chIP, chMac, chDeviceName, nHttpPort, nHttpsPort, httpType, modelType, ... }
});
discovery.start();   // broadcasts and listens
setTimeout(() => discovery.stop(), 5000);
```

---

### 2.2 ONVIF WS-Discovery (Standard)

#### 2.2.1 Protocol Description

ONVIF WS-Discovery (Web Services Dynamic Discovery) is the standard mechanism defined by the ONVIF specification for automatic discovery of network video devices. It is based on the **WS-Discovery** OASIS standard (SOAP over UDP multicast).

| Parameter | Value |
|---|---|
| Transport | UDP (IPv4) |
| Multicast address | **239.255.255.250** |
| Port | **3702** |
| Message format | SOAP 1.2 / XML |
| Probe type | `NetworkVideoTransmitter` |
| Response | `ProbeMatch` containing device XAddr (service endpoint URL) |
| Scope filters | Optional (manufacturer, location, hardware type) |

#### 2.2.2 Discovery Flow

```
Client                                    Camera(s)
  │                                           │
  │── UDP Multicast Probe ─────────────────►  │  (239.255.255.250:3702)
  │   Type: NetworkVideoTransmitter           │
  │                                           │
  │  ◄──── ProbeMatch (unicast) ─────────────│  (Camera → Client:3702)
  │   XAddrs: http://192.168.1.100/onvif/...  │
  │                                           │
  │── GetDeviceInformation (HTTP/SOAP) ─────► │  (Unicast to XAddr)
  │                                           │
  │  ◄─── DeviceInformation Response ────────│
  │   Manufacturer, Model, FirmwareVersion,   │
  │   SerialNumber, HardwareId               │
  │                                           │
  │── GetProfiles (RTSP stream list) ────────►│
  │                                           │
  │  ◄─── MediaProfiles Response ────────────│
  │   ProfileToken, Encoding, Resolution,     │
  │   StreamUri (RTSP URL)                   │
```

#### 2.2.3 SOAP Probe Message

```xml
<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
    <a:MessageID>urn:uuid:{uuid}</a:MessageID>
    <a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>
  </s:Header>
  <s:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </s:Body>
</s:Envelope>
```

#### 2.2.4 Device Metadata Retrieved

After receiving a `ProbeMatch`, the system performs secondary ONVIF service calls to retrieve full device information:

| ONVIF Service | Method | Data Retrieved |
|---|---|---|
| Device Service | `GetDeviceInformation` | Manufacturer, Model, Firmware, Serial |
| Device Service | `GetNetworkInterfaces` | MAC address, IP configuration |
| Media Service | `GetProfiles` | Stream profiles (resolution, encoding) |
| Media Service | `GetStreamUri` | RTSP stream URLs per profile |
| PTZ Service | `GetNodes` | PTZ capability (optional) |

#### 2.2.5 RTSP Profile Selection

Each ONVIF camera may expose multiple media profiles (e.g., Main Stream at 4K, Sub Stream at 640×480). The system shall:

1. Enumerate all available profiles
2. Select the **lowest-resolution profile** by default for AI analysis efficiency (width ≤ 640 preferred)
3. Allow the operator to manually select an alternate profile before adding the camera

#### 2.2.6 Credentials Handling

ONVIF device service calls require HTTP Digest authentication. The system shall:

- Attempt unauthenticated probe first (discovers XAddr without credentials)
- Prompt for credentials before `GetDeviceInformation` / `GetStreamUri` calls
- Support credential presets (default admin/admin, configurable per manufacturer)
- Store credentials securely; never transmit in plain-text logs

#### 2.2.7 Planned Implementation

- **Library**: `node-onvif` (npm) or custom SOAP/UDP client
- **Service**: `server/src/services/onvifDiscovery.js` *(TODO)*
- **Integration**: Merged into `DiscoveryService` alongside UDP Discovery
- **Deduplication**: MAC address from `GetNetworkInterfaces`; falls back to XAddr host

---

## 3. Functional Requirements

### 3.1 Core Requirements

| ID | Requirement | Priority | Status |
|---|---|:---:|:---:|
| DISC-01 | Discover WiseNet/Hanwha cameras via proprietary UDP broadcast | Must | ✅ Implemented |
| DISC-02 | Discover all ONVIF-compliant cameras via WS-Discovery multicast | Must | 🔲 TODO |
| DISC-03 | Run both discovery mechanisms concurrently in background | Must | Partial |
| DISC-04 | Deduplicate results by MAC address across both mechanisms | Must | ✅ (UDP only) |
| DISC-05 | Push discovered cameras to all connected clients in real time via Socket.IO | Must | ✅ Implemented |
| DISC-06 | Persist discovered camera list across scan cycles (no flash/disappear) | Must | ✅ Implemented |
| DISC-07 | Retrieve RTSP stream URLs for all discovered cameras | Must | ✅ (UDP) / 🔲 (ONVIF) |
| DISC-08 | Support operator-triggered rescan (clear & restart) | Should | ✅ Implemented |
| DISC-09 | Report scan progress (scanning / idle / device count) | Should | ✅ Implemented |
| DISC-10 | Filter discoverable cameras by manufacturer, model, or IP subnet | Could | 🔲 TODO |
| DISC-11 | Support ONVIF profile selection before camera registration | Should | 🔲 TODO |
| DISC-12 | Credential management for ONVIF device service calls | Must | 🔲 TODO |

### 3.2 Scan Behavior Requirements

| ID | Requirement |
|---|---|
| DISC-B01 | Each discovery mechanism operates with an independent scan timeout (default 8 s) |
| DISC-B02 | Scans repeat continuously with a short inter-scan pause (default 2 s) |
| DISC-B03 | A newly connected dashboard client receives all currently-known devices immediately (hydration) |
| DISC-B04 | Manual rescan clears all known devices and restarts both mechanisms simultaneously |
| DISC-B05 | Discovery service handles socket/network errors gracefully and retries automatically |

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LTS Backend (Node.js)                        │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     DiscoveryService                         │   │
│  │   (discoveryService.js — orchestrates both mechanisms)      │   │
│  │                                                             │   │
│  │   ┌──────────────────────┐   ┌──────────────────────────┐  │   │
│  │   │  WiseNetUDPDiscovery │   │   ONVIFDiscovery         │  │   │
│  │   │  (udpDiscovery.js)   │   │   (onvifDiscovery.js)    │  │   │
│  │   │                      │   │                          │  │   │
│  │   │  Broadcast UDP       │   │  Multicast UDP Probe     │  │   │
│  │   │  255.255.255.255:7701│   │  239.255.255.250:3702    │  │   │
│  │   │  Recv: port 7711     │   │  + ONVIF HTTP/SOAP calls │  │   │
│  │   └──────────┬───────────┘   └──────────────┬───────────┘  │   │
│  │              │                               │              │   │
│  │              └────────────┬──────────────────┘              │   │
│  │                           ▼                                 │   │
│  │              ┌─────────────────────────┐                   │   │
│  │              │  Device Registry (Map)  │                   │   │
│  │              │  Key: MAC address       │                   │   │
│  │              │  Deduplication across   │                   │   │
│  │              │  both mechanisms        │                   │   │
│  │              └────────────┬────────────┘                   │   │
│  └───────────────────────────│─────────────────────────────────┘   │
│                              │ Socket.IO events                     │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Socket.IO Server                                              │ │
│  │  discovery:result   — new/updated device                      │ │
│  │  discovery:scanning — scan state change                       │ │
│  │  discovery:cleared  — registry cleared (rescan)              │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │  Network (LAN)      │
                    │                    │
           ┌────────┴──────┐   ┌─────────┴──────┐
           │ Hanwha/WiseNet│   │  Any ONVIF     │
           │ IP Camera     │   │  IP Camera     │
           │ (UDP reply)   │   │  (SOAP reply)  │
           └───────────────┘   └────────────────┘
```

---

## 5. API Specification

### 5.1 Socket.IO Events (Server → Client)

| Event | Payload | Description |
|---|---|---|
| `discovery:result` | `{ device: DeviceInfo }` | New or updated camera found |
| `discovery:scanning` | `{ scanning: boolean, count: number }` | Scan state change |
| `discovery:cleared` | `{}` | Device registry cleared (on rescan) |
| `discovery:error` | `{ message: string }` | Non-fatal scan error |

### 5.2 REST API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/discovery/start` | Start discovery (if not running) |
| `POST` | `/api/discovery/stop` | Stop all discovery |
| `POST` | `/api/discovery/rescan` | Clear registry and restart scan |
| `GET` | `/api/discovery/devices` | Return all currently-known devices |
| `GET` | `/api/discovery/status` | Return `{ scanning, count, mechanisms[] }` |

### 5.3 Socket.IO Events (Client → Server)

| Event | Description |
|---|---|
| `discovery:rescan` | Trigger rescan (equivalent to POST /api/discovery/rescan) |
| `discovery:stop` | Stop scanning |

---

## 6. Device Information Model

Discovered cameras from both mechanisms are normalized into a common `DeviceInfo` object:

```typescript
interface DeviceInfo {
  // Identity
  id:          string;     // "{MAC}_{IP}" — stable unique identifier
  source:      'udp' | 'onvif' | 'both';  // discovery mechanism(s) that found it

  // Network
  IPAddress:   string;     // IPv4 address
  MACAddress:  string;     // MAC address (uppercase, colon-separated)
  Port:        number;     // Primary device port
  HttpPort:    number;     // HTTP port (default 80)
  HttpsPort:   number;     // HTTPS port (default 443)
  HttpType:    boolean;    // true = HTTPS only
  Gateway:     string;
  SubnetMask:  string;

  // Device
  Manufacturer: string;   // e.g. "Hanwha Vision" (ONVIF) / derived from model (UDP)
  Model:        string;   // e.g. "TID-A800"
  FirmwareVersion?: string;
  SerialNumber?:  string;
  Type?:          string; // device type string

  // Capabilities
  SupportSunapi:  boolean;  // Hanwha SUNAPI support
  SupportOnvif:   boolean;  // ONVIF protocol confirmed
  SupportPTZ?:    boolean;  // PTZ capability (from ONVIF)

  // Streams
  rtspUrl?:       string;   // Primary RTSP stream URL (pre-filled)
  profiles?:      OnvifProfile[];  // Available media profiles (ONVIF only)

  // DNS
  URL?:           string;   // DDNS URL
}

interface OnvifProfile {
  token:       string;   // Profile token
  name:        string;   // e.g. "MainStream", "SubStream"
  encoding:    string;   // "H264" | "H265" | "MJPEG"
  width:       number;
  height:      number;
  frameRate:   number;
  rtspUrl:     string;
}
```

---

## 7. Implementation Status

### 7.1 WiseNet UDP Discovery

| Component | File | Status |
|---|---|:---:|
| UDP Discovery core | `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` | ✅ |
| Discovery service orchestrator | `server/src/services/discoveryService.js` | ✅ |
| Socket.IO real-time push | `server/src/index.js` | ✅ |
| Client panel UI | `client/src/components/DiscoveredCameraPanel.tsx` | ✅ |
| Client store | `client/src/stores/discoveryStore.ts` | ✅ |
| Add-to-pipeline action | `client/src/components/DiscoveredCameraPanel.tsx` | ✅ |

### 7.2 ONVIF WS-Discovery

| Component | File | Status |
|---|---|:---:|
| ONVIF UDP probe sender | `server/src/services/onvifDiscovery.js` | 🔲 TODO |
| ONVIF SOAP client | `server/src/services/onvifClient.js` | 🔲 TODO |
| `GetDeviceInformation` | — | 🔲 TODO |
| `GetProfiles` + `GetStreamUri` | — | 🔲 TODO |
| Merge into DiscoveryService | `server/src/services/discoveryService.js` | 🔲 TODO |
| Credential prompt in UI | `client/src/components/DiscoveredCameraPanel.tsx` | 🔲 TODO |
| Profile selection UI | `client/src/components/DiscoveredCameraPanel.tsx` | 🔲 TODO |

---

## 8. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Latency** | First camera response visible in UI within 2 s of scan start |
| **Compatibility** | ONVIF Core 2.0 and above; tested against major manufacturers (Axis, Hikvision, Dahua, Hanwha, Bosch) |
| **Network impact** | Total broadcast/multicast traffic < 5 KB/scan cycle |
| **Reliability** | Automatic recovery from socket errors; no manual restart required |
| **Security** | Credentials never logged; ONVIF WS-Security (UsernameToken) support |
| **Scalability** | Handle up to 256 discovered devices without UI degradation |
| **Platform** | Linux (primary); discovery sockets require `SO_BROADCAST` and multicast join permissions |

---

## 9. Glossary

| Term | Definition |
|---|---|
| **ONVIF** | Open Network Video Interface Forum — industry standard for IP camera interoperability |
| **WS-Discovery** | Web Services Dynamic Discovery (OASIS standard) — UDP multicast-based device location protocol |
| **WiseNet** | Hanwha Vision's IP camera brand (formerly Samsung Techwin) |
| **SUNAPI** | Samsung Unified Network API — Hanwha's proprietary HTTP API for camera control |
| **XAddr** | ONVIF device service endpoint URL returned in a `ProbeMatch` response |
| **Profile** | ONVIF media configuration representing one stream (resolution, codec, frame rate) |
| **RTSP** | Real-Time Streaming Protocol — transport for live video streams |
| **UDP Broadcast** | Packet sent to all hosts on a subnet (255.255.255.255) |
| **UDP Multicast** | Packet sent to a group address (239.255.255.250 for WS-Discovery) |
| **mDNS** | Multicast DNS — zero-configuration name resolution (future consideration) |

---

## 10. NVR Multi-Channel Discovery

### 10.1 Background

Hanwha Vision NVR devices (e.g., XRN-410S, XRN-810S, XRN-1610S) expose multiple physical camera inputs — referred to as **channels** — through a single network address. The number of channels is indicated by the `MaxChannel` field returned in SUNAPI or ONVIF responses. Each channel has an independent RTSP stream URL and must be registered as a separate entry in the LTS monitoring pipeline.

### 10.2 Requirements

| ID | Requirement |
|---|---|
| RFP-CH-001 | The system **shall** detect `MaxChannel` for all WiseNet NVR devices discovered via UDP or ONVIF |
| RFP-CH-002 | When `MaxChannel > 1`, the device card in the CAMERAS discovery panel **shall** display a channel count badge (e.g., `4CH`) |
| RFP-CH-003 | Selecting a discovered NVR device **shall** present a channel selection grid (CH 1 … CH N) in the side panel |
| RFP-CH-004 | Each channel button **shall** show a green indicator (●) when an ONVIF RTSP URL is available for that channel |
| RFP-CH-005 | Clicking a channel button **shall** update the displayed RTSP URL to the corresponding stream URL |
| RFP-CH-006 | The "+ Add to System" action **shall** register the selected channel with name format `"{DeviceName} Ch{N}"` |
| RFP-CH-007 | `MaxChannel` **shall** be derived from ONVIF `GetProfiles` by counting distinct `VideoSourceConfiguration/SourceToken` values |
| RFP-CH-008 | For SUNAPI devices, a best-effort SUNAPI REST query **shall** be attempted with HTTP Basic auth using `RTSP_DEFAULT_USERNAME` / `RTSP_DEFAULT_PASSWORD` env vars (2 s timeout) |
| RFP-CH-009 | When both ONVIF and SUNAPI yield `MaxChannel`, the larger value **shall** win |
| RFP-CH-010 | SUNAPI query failure (auth failure, timeout) **shall** gracefully fall back to `MaxChannel = 1` without error |
| RFP-CH-011 | The detail panel **shall** always show a "Channels" number input allowing manual override of the detected channel count |
| RFP-CH-012 | When `SupportSunapi = true` and `MaxChannel > 1` (from SUNAPI), the channel count input max **shall** be capped at `MaxChannel`; otherwise the cap is 64 |
| RFP-CH-013 | The `channelIndex` (1-based, selected channel) **shall** be stored in the camera record when `POST /api/cameras` is called for an NVR channel |

### 10.3 UI Specification

**Camera Discovery List Card** (CAMERAS panel → Found tab):

```
┌─────────────────────────────────┐
│ ● XRN-810S                 4CH │  ← amber badge when MaxChannel > 1
│   Hanwha Vision · 192.168.1.10  │
│                           SUNAPI│
│                           ONVIF │
└─────────────────────────────────┘
```

**Channel Selection Panel** (side panel, opened on device click):

```
Channel Selection
[ CH 1 ●] [ CH 2 ●] [ CH 3  ] [ CH 4 ●]   ← ● = ONVIF RTSP available
● ONVIF profile available · Adding will use "XRN-810S Ch2"

RTSP (Ch 2)
rtsp://192.168.1.10:554/profile3/media.smp

[ + Add Ch 2 to System ]
```

### 10.4 RTSP URL Resolution & RTSP Port Confirmation (2026-07-02)

A field survey of this deployment's actual camera records found that RFP-CH-013's channel RTSP URL synthesis only worked for one of two conventions real WiseNet/Hanwha devices actually use — the majority of cameras on this network use `/<channel 0-based>/H.264/media.smp`, not `/profile<N>/media.smp` as previously assumed for all SUNAPI devices.

| ID | Requirement |
|---|---|
| RFP-CH-014 | Channel RTSP URL synthesis **shall** recognize both `/profileN/` (1-based) and `/N/H.264/` (0-based channel segment) path conventions, preserving whichever one an already-known base URL uses |
| RFP-CH-015 | When no base RTSP URL is known at all (fresh IP, not yet added), the system **shall** synthesize a default URL using the `/N/H.264/` convention rather than leaving the channel's URL unresolved |
| RFP-CH-016 | When credentials are available, the system **shall** confirm the device's actually-configured RTSP port via a SUNAPI CGI query (`network.cgi?msubmenu=portconf&action=view`) rather than always assuming port 554; falls back to 554 when unconfirmed |
| RFP-CH-017 | The channel detection response **shall** report SUNAPI's and ONVIF's own resolved RTSP URLs independently (not only the merged "winning" protocol), so the UI can display both side by side |

### 10.5 UDP Discovery Fallback Protocol Parity (2026-07-02)

Camera discovery has two UDP broadcast implementations — the `submodules/WiseNetChromeIPInstaller` git submodule, and a self-contained inline fallback used when the submodule isn't initialised. An audit (prompted by the vendor's own SUNAPI IP Installer protocol document, §3.4 "IP Scan for SUNAPI") found the fallback was never actually capable of discovering a WiseNet/SUNAPI device — it implemented an ONVIF XML parser instead of the WiseNet binary protocol its own ports (7701/7711) are for.

| ID | Requirement |
|---|---|
| RFP-CH-018 | The inline UDP discovery fallback **shall** implement the same WiseNet SUNAPI "IP Scan" binary request/response protocol as the git submodule implementation, not a substitute/different protocol |
| RFP-CH-019 | Both discovery implementations **shall** produce identical parsed field values for the same response bytes — a deployment without the submodule initialised must not silently lose SUNAPI/WiseNet camera discoverability |

### 10.6 nMode-Driven Response Parsing + Field Offset Correction (2026-07-03)

Two findings from a customer review of the parser against the vendor's own Annex A C structs and Table 1/2 `nMode` enum: a real field-offset bug (`supported_protocol`/`no_password`), and a structural gap — the extended field block's presence was being inferred from packet length rather than read from the response's own declared `nMode`.

| ID | Requirement |
|---|---|
| RFP-CH-020 | `_parseResponse()` **shall** parse `supported_protocol` and `no_password` as two distinct fields at their own correct offsets (per Annex A's `DATAPACKET_EXT_IPv4_T`/`_IPv6_T`), not one field silently reading the other's byte |
| RFP-CH-021 | Whether the extended field block is parsed at all **shall** be determined by the response's own `nMode` value (`12` = `DEF_RES_SCAN_EXT`), not merely by whether enough trailing bytes are present |
| RFP-CH-022 | The parser **shall** recognize the full `nMode` enum from the vendor spec's Table 1/2 (12 named values) and immediately reject (return no device) any response whose `nMode` belongs to a different exchange entirely (RSA key exchange, password-apply) rather than attempting to read it with the IP-Scan struct layout |

### 10.7 Protocol struct correction, request opcode switch, dependency consolidation, RTSP port fix (2026-07-03)

Continued Annex A cross-checking (RFP-CH-020~022) surfaced a further struct-layout gap, and separately, an architecture review found the inline fallback (RFP-CH-018~019) was worth retiring in favor of a proper npm dependency; a related field-misuse bug (RTSP port) and an auth-detection gap were found during the same pass.

| ID | Requirement |
|---|---|
| RFP-CH-023 | The shared request/response struct **shall** include Annex A's `reserved2`/`reserved3` fields (334 bytes total, not 332) — the vendor's own §3.2/§3.3 summary tables omit both |
| RFP-CH-024 | The discovery request opcode **shall** default to the vendor-documented `nMode=6` (`DEF_REQ_SCAN_EXT`); the previously-used undocumented `nMode=1` **shall** remain available as an immediate, one-line rollback |
| RFP-CH-025 | `server/src/utils/udpDiscovery.js` **shall NOT** maintain an independent socket/parsing implementation; it **shall** be installable via `npm install` (in addition to the existing git submodule path) without that installation failing to abort the rest of the server's dependency install |
| RFP-CH-026 | Synthesized RTSP URLs **shall NOT** use `nTcpPort` or `nPort` as the RTSP port (neither field is documented or observed to carry it) — both **shall** default to SUNAPI's standard port 554 |
| RFP-CH-027 | SUNAPI CGI Digest-authentication challenge detection **shall** recognize a `Digest` scheme offer regardless of its position within a `WWW-Authenticate` header that advertises multiple schemes |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Camera Discovery |
| 1.1 | 2026-06-23 | LTS Engineering Team | §10 추가 — NVR MaxChannel 다중 채널 탐색 요구사항 및 UI 명세 |
| 1.2 | 2026-06-24 | LTS Engineering Team | §10.2 업데이트 — RFP-CH-008 SUNAPI 인증 추가, RFP-CH-011~013 수동 오버라이드·상한·channelIndex 저장 추가 |
| 1.3 | 2026-07-02 | LTS Engineering Team | §10.4 신규 추가 — RFP-CH-014~017, 실 카메라 DB 조사 결과 채널 RTSP URL 컨벤션이 `/profileN/`뿐 아니라 `/N/H.264/`(0-based)도 실제 다수 사용 중임을 확인, RTSP 포트 CGI 확인 및 프로토콜별 URL 독립 보고 요구사항 추가. 헤더 Version을 이력 표 최신값과 일치하도록 정정(1.1→1.2 누락 반영) |
| 1.4 | 2026-07-02 | LTS Engineering Team | §10.5 신규 추가 — RFP-CH-018~019, UDP Discovery 인라인 폴백이 실제로는 WiseNet 바이너리 프로토콜이 아닌 ONVIF XML을 파싱하고 있어 서브모듈 미초기화 시 SUNAPI 카메라를 전혀 탐색 못 하던 결함 발견, 서브모듈과의 프로토콜/파싱 결과 동등성 요구사항 추가 |
| 1.5 | 2026-07-03 | LTS Engineering Team | §10.6 신규 추가 — RFP-CH-020~022, 고객이 Annex A 구조체와 대조해 발견한 `supported_protocol`/`no_password` 오프셋 버그, 그리고 확장 필드 블록 존재 여부가 패킷 길이가 아니라 응답의 `nMode`(Table 1/2 enum)로 결정되어야 한다는 요구사항 추가 |
| 1.6 | 2026-07-03 | LTS Engineering Team | §10.7 신규 추가 — RFP-CH-023~027: `reserved2`/`reserved3` 구조체 반영(334바이트), 요청 옵코드 `nMode=6` 기본 전환, 인라인 폴백 제거 및 npm 설치 경로 요구사항으로 대체(RFP-CH-018~019 상위 대체), RTSP URL이 `nTcpPort`/`nPort`를 쓰지 않아야 함, Digest 인증 감지가 콤바인드 헤더를 인식해야 함 |
