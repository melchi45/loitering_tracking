# RFP — Camera Discovery & Network Search Subsystem
**Document ID**: LTS-2026-002  
**Version**: 1.0  
**Date**: 2026-05-18  
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

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Camera Discovery |
