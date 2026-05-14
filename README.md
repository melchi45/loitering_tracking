# Loitering Detection & Tracking System (LTS-2026)

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18%2B-blue)](https://react.dev/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Repository](https://img.shields.io/badge/GitHub-melchi45%2Floitering__tracking-black)](https://github.com/melchi45/loitering_tracking)

> **RFP Reference:** LTS-2026-001 | **Issue Date:** May 14, 2026 | **Repository:** [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [IP Camera Discovery (UDP Broadcast)](#4-ip-camera-discovery-udp-broadcast)
5. [RTSP Video Ingestion & Frame Capture](#5-rtsp-video-ingestion--frame-capture)
6. [AI Models & Inference Pipeline](#6-ai-models--inference-pipeline)
7. [Loitering Detection Logic](#7-loitering-detection-logic)
8. [React Web UI](#8-react-web-ui)
9. [Submodules](#9-submodules)
10. [Technical Requirements](#10-technical-requirements)
11. [Functional Requirements](#11-functional-requirements)
12. [Non-Functional Requirements](#12-non-functional-requirements)
13. [Project Milestones & Deliverables](#13-project-milestones--deliverables)
14. [Getting Started](#14-getting-started)
15. [API Reference](#15-api-reference)
16. [Appendix](#16-appendix)

---

## 1. Project Overview

### 1.1 Purpose

An AI-powered **Loitering Detection and Tracking System** built on **Node.js + React**. The system ingests RTSP video streams from WiseNet/ONVIF IP cameras, performs real-time person detection and tracking using AI models, and delivers bounding-box-annotated live video to a React web UI with loitering behavior alerts.

### 1.2 Background

Traditional CCTV monitoring is reactive and prone to human error. This system automates surveillance by:

- Discovering IP cameras on the network via UDP broadcast (ported from [WiseNetChromeIPInstaller](https://github.com/melchi45/WiseNetChromeIPInstaller))
- Connecting to cameras over RTSP and capturing frames at **10 FPS**
- Running on-server AI inference to detect persons and assign persistent object IDs
- Streaming annotated frames (bounding boxes + track IDs + confidence) to a React web UI in real-time

### 1.3 Scope of Work

| Component | Description |
|---|---|
| UDP Camera Discovery | Node.js dgram port of Chrome UDP broadcast (send: 7701, recv: 7711) |
| RTSP Ingestion | FFmpeg/fluent-ffmpeg capture at 10 FPS per channel |
| AI Pipeline | YOLOv8n (ONNX) detection + ByteTrack MOT on Node.js server |
| WebSocket Streaming | Annotated JPEG frames pushed to React via Socket.IO |
| React Dashboard | Live multi-camera grid, bounding boxes, loitering alerts |
| Zone Management | Polygon-based inclusion/exclusion zones drawn on canvas |
| Alert Service | In-app + webhook notifications |

---

## 2. System Architecture

```
[WiseNet IP Cameras]
        │  UDP Broadcast Discovery (port 7701/7711)
        │  RTSP Stream (rtsp://<ip>:<port>/...)
        ▼
┌─────────────────────────────────────────┐
│         Node.js Backend Server          │
│                                         │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │ UDP Discovery│  │  RTSP Capture   │  │
│  │  (dgram)     │  │ (FFmpeg 10 FPS) │  │
│  └──────────────┘  └────────┬────────┘  │
│                             │ raw frame  │
│                    ┌────────▼────────┐  │
│                    │  AI Inference   │  │
│                    │  YOLOv8n ONNX   │  │
│                    │  + ByteTrack    │  │
│                    └────────┬────────┘  │
│                             │ detections │
│                    ┌────────▼────────┐  │
│                    │ Behavior Engine │  │
│                    │ (Loitering Logic│  │
│                    │  Zone Manager)  │  │
│                    └────────┬────────┘  │
│            ┌────────────────┼────────┐  │
│            ▼                ▼        ▼  │
│      [Alert Svc]     [REST API]  [WS]  │
│      [Storage]       [Express]  [IO]   │
└─────────────────────────────────────────┘
                             │ Socket.IO
                             │ (annotated JPEG + detections JSON)
                    ┌────────▼────────┐
                    │  React Web UI   │
                    │  Live Grid View │
                    │  BBox Overlay   │
                    │  Alert Panel    │
                    └─────────────────┘
```

### 2.1 Core Components

| # | Component | Technology | Role |
|---|---|---|---|
| 1 | UDP Discovery Service | Node.js `dgram` | Discover WiseNet cameras on LAN |
| 2 | RTSP Capture Service | FFmpeg + fluent-ffmpeg | Decode RTSP stream, extract 10 FPS |
| 3 | Detection Engine | ONNX Runtime + YOLOv8n | Person bounding box inference |
| 4 | Tracking Engine | ByteTrack (JS/Python bridge) | Persistent object ID across frames |
| 5 | Behavior Analysis Engine | Custom JS | Loitering dwell-time logic |
| 6 | Zone Manager | GeoJSON polygons | Per-camera zone configuration |
| 7 | WebSocket Server | Socket.IO | Push annotated frames to React |
| 8 | REST API | Express.js | Camera/zone/alert management |
| 9 | React Dashboard | React 18 + TypeScript | Live video + bounding box UI |
| 10 | Alert Service | EventEmitter + webhook | Loitering event notifications |

---

## 3. Technology Stack

### 3.1 Backend (Node.js)

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Runtime | Node.js | 18+ LTS | Server runtime |
| HTTP/API | Express.js | 4.x | REST API + static serving |
| WebSocket | Socket.IO | 4.x | Real-time frame streaming |
| RTSP Capture | fluent-ffmpeg | 2.x | RTSP decode + frame extract |
| AI Inference | onnxruntime-node | 1.17+ | YOLOv8n ONNX inference |
| Image Processing | sharp | 0.33+ | Frame resize/crop/encode |
| UDP Discovery | Node.js built-in `dgram` | — | Camera broadcast discovery |
| Database | better-sqlite3 | 9.x | Event/alert storage |
| Process Manager | PM2 | 5.x | Production process management |

### 3.2 Frontend (React)

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Framework | React | 18+ | Web UI |
| Language | TypeScript | 5.x | Type safety |
| Build | Vite | 5.x | Fast dev server + bundler |
| UI Library | shadcn/ui + Tailwind CSS | — | Component system |
| Video Display | HTML5 `<img>` / Canvas | — | MJPEG-over-Socket.IO |
| BBox Overlay | HTML5 Canvas API | — | Bounding box + track ID |
| State | Zustand | 4.x | Client state management |
| Charts | Recharts | 2.x | Analytics & heatmaps |

### 3.3 AI Models

| Model | Format | Task | Size | Latency* |
|---|---|---|---|---|
| YOLOv8n | ONNX | Person detection (primary) | ~6MB | ~15ms |
| YOLOv8s | ONNX | Person detection (higher accuracy) | ~22MB | ~30ms |
| ByteTrack | JS implementation | Multi-object tracking | — | ~5ms |
| MobileNetV2 Re-ID | ONNX | Person re-identification | ~14MB | ~10ms |

> \* Latency measured on Intel Core i7 CPU. GPU via NVIDIA CUDA reduces by 3–5×.

#### Required AI Model Files

Place model files in `server/models/`:

```
server/models/
├── yolov8n.onnx          # Primary detection model
├── yolov8s.onnx          # High-accuracy detection model (optional)
└── reid_mobilenetv2.onnx # Re-ID model for persistent tracking
```

**Download commands:**
```bash
# YOLOv8n ONNX (Ultralytics)
python3 -c "from ultralytics import YOLO; YOLO('yolov8n.pt').export(format='onnx')"
# Or download directly:
wget https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.onnx -O server/models/yolov8n.onnx
```

---

## 4. IP Camera Discovery (UDP Broadcast)

### 4.1 Overview

Ported from [WiseNetChromeIPInstaller](https://github.com/melchi45/WiseNetChromeIPInstaller) (Chrome `sockets.udp` API → Node.js `dgram` module).

The discovery protocol sends a proprietary WiseNet UDP broadcast packet and parses binary responses from cameras on the local network.

### 4.2 Protocol Specification

| Parameter | Value |
|---|---|
| Send Port | **7701** (broadcast to cameras) |
| Receive Port | **7711** (listen for responses) |
| Broadcast Address | `255.255.255.255` |
| Listen Address | `0.0.0.0` |

**Discovery packet (hex):**
```
018750735306465625ef6da75b047d7bcd1c3c001800000000000000f0eacf00
000000000000000000000000faf8ec76000000000000000050ea18001a01ec76
f0e9180000000000e4ea18008000ec76f0eacf0000000000f0000000...
```

### 4.3 Response Packet Format

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
| `chDeviceName` | 10 | string | Device name (short) |
| `Reserved2` | 1 | bytes | Reserved |
| `nHttpPort` | 2 | uint16 BE | HTTP port |
| `nDevicePort` | 2 | uint16 BE | Device port |
| `nTcpPort` | 2 | uint16 BE | TCP port |
| `nUdpPort` | 2 | uint16 BE | UDP port |
| `nUploadPort` | 2 | uint16 BE | Upload port |
| `nMulticastPort` | 2 | uint16 BE | Multicast port |
| `nNetworkMode` | 1 | uint8 | Network mode |
| `DDNSURL` | 128 | string | DDNS URL |
| `alias` | 32 | string | Camera alias (if len ≥ 261) |
| `chDeviceNameNew` | 32 | string | Device name (if len ≥ 261) |
| `modelType` | 1 | uint8 | Model type (if len ≥ 261) |
| `version` | 2 | uint16 | Firmware version (if len ≥ 261) |
| `httpType` | 1 | uint8 | 0=HTTP, 1=HTTPS (if len ≥ 261) |
| `Reserved3` | 1 | bytes | Reserved (if len ≥ 261) |
| `nHttpsPort` | 2 | uint16 BE | HTTPS port (if len ≥ 261) |
| `noPassword` | 1 | uint8 | No-password flag (if len ≥ 261) |

### 4.4 Node.js Implementation

The Node.js UDP discovery module is maintained in a dedicated branch of the submodule:

```
submodules/WiseNetChromeIPInstaller/   (branch: nodejs-udp-discovery)
└── nodejs/
    ├── udpDiscovery.js     # Core discovery module (dgram port)
    ├── utils.js            # ntohs/ntohl/bytes2int helpers
    └── index.js            # Example usage / CLI
```

**Usage from Node.js server:**
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

## 5. RTSP Video Ingestion & Frame Capture

### 5.1 Overview

The Node.js server connects to each discovered (or manually configured) camera via RTSP and extracts frames at **10 FPS** using FFmpeg. Frames are converted to JPEG and passed to the AI inference pipeline.

### 5.2 RTSP Connection

```
rtsp://<username>:<password>@<camera-ip>:<port>/profile1/media.smp
```

Supported RTSP URL formats:
- WiseNet/Hanwha: `rtsp://<ip>/profile1/media.smp` (ONVIF Profile S)
- Generic ONVIF: `rtsp://<ip>/onvif/media`
- Manual URL: configurable per camera

### 5.3 Frame Capture Pipeline

```
RTSP Stream (H.264/H.265)
    │
    ▼ FFmpeg (fluent-ffmpeg)
    │  -vf fps=10 -f image2pipe -vcodec mjpeg
    │
    ▼ Node.js Buffer (JPEG)
    │
    ▼ sharp (resize to 640×384 for inference)
    │
    ▼ Float32Array (normalized [0,1] RGB)
    │
    ▼ ONNX Runtime (YOLOv8n inference)
    │
    ▼ Detection Results [{bbox, confidence, classId}]
    │
    ▼ ByteTrack (assign/maintain objectId)
    │
    ▼ Annotated frame + [{objectId, bbox, confidence}]
    │
    ▼ Socket.IO → React UI
```

### 5.4 Performance Targets

| Metric | Target | Notes |
|---|---|---|
| Capture frame rate | 10 FPS | Per channel |
| Inference latency | ≤ 50ms/frame | CPU; ≤ 15ms GPU |
| End-to-end latency | ≤ 500ms | Capture → UI |
| Concurrent channels | ≥ 4 (CPU) | ≥ 16 (GPU) |

---

## 6. AI Models & Inference Pipeline

### 6.1 Detection: YOLOv8n (ONNX)

- Input: 640×640 normalized RGB tensor `[1, 3, 640, 640]`
- Output: `[1, 84, 8400]` — 4 bbox coords + 80 class scores per anchor
- Person class ID: **0** (COCO dataset)
- Confidence threshold: **0.45** (configurable)
- NMS IoU threshold: **0.5** (configurable)
- Post-processing: NMS → filter person class → scale boxes to frame size

### 6.2 Multi-Object Tracking: ByteTrack

ByteTrack operates on detection outputs and maintains persistent `objectId` across frames:

- **High-confidence tracks** (conf ≥ 0.6): matched via IoU
- **Low-confidence tracks** (0.1 ≤ conf < 0.6): used for occlusion recovery
- **Track states**: `Tracked` → `Lost` (30 frames) → `Removed`
- **Max track age**: 30 frames (configurable)
- **Re-ID distance**: Kalman filter predicted position IoU

### 6.3 Detection Output Schema

Each frame produces a JSON array of detections:

```json
{
  "frameId": 12345,
  "timestamp": 1715678901234,
  "cameraId": "cam-01",
  "detections": [
    {
      "objectId": 7,
      "confidence": 0.891,
      "bbox": {
        "x": 120,
        "y": 85,
        "width": 65,
        "height": 190
      },
      "class": "person",
      "isLoitering": false,
      "dwellTime": 12.4
    }
  ]
}
```

### 6.4 Loitering Condition

An `objectId` is flagged as loitering when:

```
dwellTime > threshold  AND  displacement < minDisplacement
```

| Parameter | Default | Configurable |
|---|---|---|
| Dwell time threshold | 30 seconds | Per zone (5s–600s) |
| Min displacement | 50 pixels | Per zone |
| Re-entry window | 120 seconds | Per zone |
| Crowd density filter | 5 persons | Auto-adjust |

---

## 7. Loitering Detection Logic

### 7.1 Behavioral Analysis Engine

```
For each tracked object per frame:
  1. Update position history (circular buffer, 300 frames)
  2. Calculate displacement: max(bbox_center) over last N frames
  3. Calculate dwell time: frames_in_zone × (1/fps)
  4. If dwell_time > threshold AND displacement < min_displacement:
     → emit LOITERING_ALERT event
  5. On re-entry within re_entry_window:
     → increment re_entry_count
     → reduce dwell_time threshold by 50%
```

### 7.2 Zone-Based Analysis

- Zones defined as GeoJSON polygons in pixel coordinates
- Point-in-polygon test (ray casting) per detection per frame
- Up to **50 zones** per camera feed
- Zone types: `MONITOR` (trigger alerts), `EXCLUDE` (suppress alerts)
- Time-based activation: cron-style schedule per zone

---

## 8. React Web UI

### 8.1 Live Video with Bounding Box Overlay

The React UI receives annotated data from the Node.js server via Socket.IO:

1. **Video stream**: JPEG frames sent as `frame` events (base64)
2. **Detection data**: JSON detections sent as `detections` event (same timestamp)
3. **Rendering**: `<img>` tag for video frame + `<canvas>` overlay for bounding boxes

**Bounding Box Rendering:**
```
<div style="position:relative">
  <img id="video-frame" src={currentFrame} />
  <canvas id="bbox-overlay"
          style="position:absolute; top:0; left:0"
          width={frameWidth} height={frameHeight} />
</div>
```

Each detection renders:
- **Rectangle**: bbox outline (green = normal, red = loitering)
- **Label**: `ID:7  0.89` (objectId + confidence, top-left of bbox)
- **Dwell timer**: seconds counter (bottom-right, appears when dwell > 5s)

### 8.2 Dashboard Layout

```
┌─────────────────────────────────────────────────────┐
│  LTS Dashboard          [Camera: cam-01 ▼]  [⚙️]   │
├──────────────────────────────┬──────────────────────┤
│                              │  Alert Panel         │
│   Live Video Feed            │  ┌────────────────┐  │
│   [<img> + <canvas> overlay] │  │ ⚠️ ID:7 Cam01  │  │
│                              │  │ Loitering 42s  │  │
│   ID:3  0.91  [bbox]         │  └────────────────┘  │
│   ID:7  0.89  [bbox] 🔴42s   │                      │
│                              │  Camera List         │
├──────────────────────────────│  ○ cam-01 (live)     │
│  Camera Grid (1/4/9/16 view) │  ○ cam-02 (live)     │
│  [cam-01][cam-02][cam-03]... │  + Add Camera        │
└──────────────────────────────┴──────────────────────┘
```

### 8.3 Camera Management

- Auto-populate discovered cameras from UDP broadcast
- Manual RTSP URL entry
- Per-camera: start/stop stream, zone configuration, sensitivity settings

---

## 9. Submodules

### 9.1 WiseNetChromeIPInstaller (Node.js UDP branch)

```bash
# Initialize after cloning loitering_tracking
git submodule update --init --recursive
```

| Path | Repository | Branch |
|---|---|---|
| `submodules/WiseNetChromeIPInstaller` | [github.com/melchi45/WiseNetChromeIPInstaller](https://github.com/melchi45/WiseNetChromeIPInstaller) | `nodejs-udp-discovery` |

The `nodejs-udp-discovery` branch adds:
- `nodejs/udpDiscovery.js` — Node.js `dgram` port of Chrome `sockets.udp` discovery
- `nodejs/utils.js` — `ntohs`/`ntohl`/`bytes2int` helpers
- `nodejs/package.json` — Node.js module config
- `nodejs/README.md` — Usage instructions

---

## 10. Technical Requirements

### 10.1 Video Input & Ingestion

- Support RTSP, RTMP, HTTP(S) input via FFmpeg
- Compatible with ONVIF-compliant IP cameras (WiseNet/Hanwha)
- Frame capture: **10 FPS** (configurable: 1–30 FPS)
- Resolution support: 720p, 1080p (inference at 640×640)
- Hardware-accelerated decoding: NVDEC (NVIDIA), QSV (Intel), VA-API

### 10.2 Object Detection

| Metric | Minimum | Target |
|---|---|---|
| Detection Model | YOLOv8n ONNX | YOLOv8s ONNX |
| Person mAP@0.5 | ≥ 85% | ≥ 92% |
| Inference Latency | ≤ 50ms/frame (CPU) | ≤ 15ms/frame (GPU) |
| False Positive Rate | ≤ 5% | ≤ 2% |

### 10.3 Multi-Object Tracking

- Algorithm: ByteTrack (primary), DeepSORT (alternative)
- Persistent `objectId` assignment across frames
- Track re-identification after occlusion (up to 30 frames)
- Tracking accuracy: HOTA ≥ 60, MOTA ≥ 70 on MOT17

### 10.4 WebSocket Streaming

- Protocol: Socket.IO over WebSocket
- Frame delivery: JPEG base64, target ≤ 100KB/frame at 10 FPS
- Detection data: JSON, delivered with each frame event
- Reconnect: automatic with exponential backoff

---

## 11. Functional Requirements

### 11.1 Dashboard & UI

- Live multi-camera grid view (1/4/9/16 layout)
- Per-frame bounding boxes with `objectId` and `confidence` score
- Loitering indicator: color change (green→yellow→red) with dwell timer
- Real-time loitering event log with camera thumbnail
- Zone drawing: polygon tool on canvas
- Alert history: filterable by camera, zone, time, severity
- Heatmap: dwell-time visualization per zone

### 11.2 Alerting & Notifications

- In-app alert with visual highlight and audio cue
- Webhook POST to configurable endpoint
- Email notification (nodemailer)
- Alert cool-down: configurable per zone (default 60s)

### 11.3 Camera Discovery & Management

- **UDP broadcast discovery** of WiseNet cameras on LAN (one-click scan)
- Manual camera entry: RTSP URL, credentials
- Per-camera: stream start/stop, resolution, FPS override
- Connection status indicator (live/offline/error)

### 11.4 Video Evidence

- Automatic clip save on loitering event (±30s buffer)
- H.264 MP4 stored in `storage/clips/`
- Event log with metadata: cameraId, objectId, startTime, duration, clip path

---

## 12. Non-Functional Requirements

### 12.1 Security

- TLS 1.3 for all WebSocket and REST connections in production
- OWASP Top 10 compliance for web interface
- JWT Bearer token authentication for API and Socket.IO
- GDPR/PDPA: video retention policy, right-to-erasure API

### 12.2 Scalability & Reliability

- Minimum 4 concurrent channels on CPU-only server
- Minimum 16 concurrent channels with NVIDIA GPU
- Graceful degradation: alerting continues if UI disconnects
- Health check endpoint: `GET /api/health`

### 12.3 Maintainability

- ESLint + Prettier code style enforcement
- Jest unit tests (≥ 70% coverage for core pipeline)
- GitHub Actions CI: lint → test → build
- Docker Compose for single-command local deployment

---

## 13. Project Milestones & Deliverables

| Phase | Milestone | Deliverables | Target |
|:---:|---|---|:---:|
| 1 | Project Setup | Repo structure, submodule, Docker Compose, CI | Week 1 |
| 2 | UDP Discovery | Node.js UDP discovery module, camera list UI | Week 2 |
| 3 | RTSP Capture | FFmpeg ingestion, 10 FPS frame pipeline | Week 3 |
| 4 | AI Detection | YOLOv8n ONNX inference, NMS, bounding boxes | Week 5 |
| 5 | MOT Tracking | ByteTrack integration, persistent objectId | Week 6 |
| 6 | React UI | Live video + bbox overlay, camera grid | Week 8 |
| 7 | Loitering Logic | Dwell time engine, zone manager, alerts | Week 10 |
| 8 | Alert Service | In-app + webhook + email notifications | Week 11 |
| 9 | Integration | Full pipeline E2E, performance tuning | Week 13 |
| 10 | UAT & QA | Performance tests, security audit, bug fixes | Week 15 |
| 11 | Deployment | Docker image, docs, production deployment | Week 16 |

---

## 14. Getting Started

### 14.1 Prerequisites

```bash
# System
Node.js 18+ LTS
FFmpeg 6.x (with libx264, libx265)
Python 3.10+ (for ONNX model export only)

# Optional (GPU acceleration)
NVIDIA GPU + CUDA 12.x + cuDNN 8.x
```

### 14.2 Installation

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/melchi45/loitering_tracking.git
cd loitering_tracking

# Install backend dependencies
cd server && npm install

# Install frontend dependencies
cd ../client && npm install

# Download AI models
cd ../server
mkdir -p models
wget https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.onnx \
     -O models/yolov8n.onnx
```

### 14.3 Configuration

```bash
cp server/.env.example server/.env
# Edit server/.env:
# PORT=3001
# RTSP_DEFAULT_USERNAME=admin
# RTSP_DEFAULT_PASSWORD=
# YOLO_MODEL=models/yolov8n.onnx
# CONFIDENCE_THRESHOLD=0.45
# LOITERING_THRESHOLD_SEC=30
# JWT_SECRET=your-secret-key
```

### 14.4 Running

```bash
# Development
cd server && npm run dev      # Node.js server on :3001
cd client && npm run dev      # React dev server on :5173

# Production (Docker)
docker-compose up -d
# → React UI:  http://localhost:3000
# → API:       http://localhost:3001/api
```

---

## 15. API Reference

### 15.1 REST Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | System health check |
| `GET` | `/api/cameras` | List all cameras |
| `POST` | `/api/cameras/discover` | Trigger UDP broadcast discovery |
| `POST` | `/api/cameras` | Add camera (manual RTSP URL) |
| `DELETE` | `/api/cameras/:id` | Remove camera |
| `POST` | `/api/cameras/:id/stream/start` | Start RTSP capture |
| `POST` | `/api/cameras/:id/stream/stop` | Stop RTSP capture |
| `GET` | `/api/cameras/:id/zones` | Get zones for camera |
| `PUT` | `/api/cameras/:id/zones` | Update zones |
| `GET` | `/api/events` | List loitering events |
| `GET` | `/api/events/:id/clip` | Download event video clip |

### 15.2 Socket.IO Events

| Event | Direction | Payload | Description |
|---|---|---|---|
| `frame` | Server→Client | `{ cameraId, frameId, timestamp, data: base64jpeg }` | Raw annotated frame |
| `detections` | Server→Client | `{ cameraId, frameId, timestamp, detections: [...] }` | Detection + tracking results |
| `alert` | Server→Client | `{ cameraId, objectId, zone, dwellTime, timestamp }` | Loitering alert |
| `camera:status` | Server→Client | `{ cameraId, status: 'live'|'offline'|'error' }` | Camera status change |
| `camera:subscribe` | Client→Server | `{ cameraId }` | Subscribe to camera stream |
| `camera:unsubscribe` | Client→Server | `{ cameraId }` | Unsubscribe |
| `discovery:start` | Client→Server | `{}` | Trigger UDP camera discovery |
| `discovery:result` | Server→Client | `{ cameras: [...] }` | Discovery results |

---

## 16. Appendix

### Appendix A: Glossary

| Term | Definition |
|---|---|
| **Loitering** | Remaining in a location longer than a configured threshold without apparent purpose |
| **ObjectId** | Persistent integer ID assigned to a tracked person across frames by ByteTrack |
| **Confidence** | Detection confidence score (0.0–1.0) from YOLOv8n for each bounding box |
| **Bounding Box** | Rectangle `{x, y, width, height}` in pixel coordinates enclosing a detected person |
| **ByteTrack** | Multi-object tracking algorithm using low-confidence detections for occlusion recovery |
| **RTSP** | Real Time Streaming Protocol — standard for IP camera video streaming |
| **ONVIF** | Open Network Video Interface Forum — IP camera interoperability standard |
| **WiseNet** | Hanwha Vision brand for IP cameras and surveillance equipment |
| **SUNAPI** | Samsung/Hanwha camera HTTP API for camera control |
| **UDP Broadcast** | Network broadcast to 255.255.255.255 for device discovery on LAN |
| **MOT** | Multi-Object Tracking — tracking multiple persons simultaneously across frames |
| **NMS** | Non-Maximum Suppression — removes duplicate detection boxes |
| **ONNX** | Open Neural Network Exchange — cross-platform AI model format |

### Appendix B: Directory Structure

```
loitering_tracking/
├── README.md                        # This file
├── docker-compose.yml               # Full stack deployment
├── .gitmodules                      # Submodule configuration
├── submodules/
│   └── WiseNetChromeIPInstaller/    # branch: nodejs-udp-discovery
│       └── nodejs/
│           ├── udpDiscovery.js
│           ├── utils.js
│           └── package.json
├── server/                          # Node.js backend
│   ├── package.json
│   ├── src/
│   │   ├── index.js                 # Entry point (Express + Socket.IO)
│   │   ├── services/
│   │   │   ├── udpDiscovery.js      # Camera discovery (uses submodule)
│   │   │   ├── rtspCapture.js       # FFmpeg RTSP → 10 FPS frames
│   │   │   ├── detection.js         # YOLOv8n ONNX inference
│   │   │   ├── tracking.js          # ByteTrack MOT
│   │   │   ├── behaviorEngine.js    # Loitering dwell-time logic
│   │   │   ├── zoneManager.js       # Polygon zone management
│   │   │   └── alertService.js      # Alert generation + webhook
│   │   ├── api/
│   │   │   ├── cameras.js           # Camera CRUD routes
│   │   │   ├── events.js            # Event log routes
│   │   │   └── zones.js             # Zone config routes
│   │   └── socket/
│   │       └── streamHandler.js     # Socket.IO frame/detection push
│   ├── models/                      # ONNX model files (gitignored)
│   │   ├── yolov8n.onnx
│   │   └── reid_mobilenetv2.onnx
│   └── storage/                     # Event clips + DB (gitignored)
│       ├── events.db
│       └── clips/
├── client/                          # React frontend
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── CameraView.tsx       # <img> + <canvas> bbox overlay
│       │   ├── CameraGrid.tsx       # 1/4/9/16 grid layout
│       │   ├── AlertPanel.tsx       # Real-time loitering alerts
│       │   ├── ZoneEditor.tsx       # Polygon zone drawing canvas
│       │   └── CameraList.tsx       # Camera management sidebar
│       ├── hooks/
│       │   ├── useSocket.ts         # Socket.IO connection hook
│       │   └── useCamera.ts         # Camera stream state
│       └── stores/
│           ├── cameraStore.ts       # Zustand camera state
│           └── alertStore.ts        # Zustand alert state
└── .github/
    └── workflows/
        └── ci.yml                   # Lint + test + build
```

### Appendix C: Original RFP

Original RFP document: `RFP_LTS2026_Loitering_Tracking_System.md`

> **END OF DOCUMENT — LTS-2026-001**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
