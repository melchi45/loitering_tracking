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
7. [Per-Channel AI Module Selection](#7-per-channel-ai-module-selection)
8. [Loitering Detection Logic](#8-loitering-detection-logic)
9. [React Web UI](#9-react-web-ui)
10. [Submodules](#10-submodules)
11. [Technical Requirements](#11-technical-requirements)
12. [Functional Requirements](#12-functional-requirements)
13. [Non-Functional Requirements](#13-non-functional-requirements)
14. [Project Milestones & Deliverables](#14-project-milestones--deliverables)
15. [Getting Started](#15-getting-started)
16. [API Reference](#16-api-reference)
17. [Appendix](#17-appendix)

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

| Model | Format | Task | Classes | Size | Latency* |
|---|---|---|---|---|---|
| YOLOv8n | ONNX | Multi-class detection (primary) | person, bicycle, car, motorcycle, bus, truck | ~6MB | ~15ms |
| YOLOv8s | ONNX | Multi-class detection (higher accuracy) | same as above | ~22MB | ~30ms |
| ByteTrack | JS implementation | Multi-object tracking | — | — | ~5ms |
| MobileNetV2 Re-ID | ONNX | Person re-identification | — | ~14MB | ~10ms |
| RetinaFace *(planned)* | ONNX | Face detection | face | ~4MB | ~20ms |
| Attribute classifier *(planned)* | ONNX | Mask / Color / Cloth / Hat / Accessories | 8 attribute types | ~8MB | ~5–15ms/crop |

> \* Latency measured on Intel Core i7 CPU. GPU via NVIDIA CUDA reduces by 3–5×.

#### Enabled COCO Classes (YOLOv8n)

The detection service detects the following COCO classes by default:

| COCO ID | Class Name | Zone Target Key |
|---|---|---|
| 0 | person | `human` |
| 1 | bicycle | `vehicle` |
| 2 | car | `vehicle` |
| 3 | motorcycle | `vehicle` |
| 5 | bus | `vehicle` |
| 7 | truck | `vehicle` |

Zones with `targetClasses: ['human']` only trigger loitering logic for persons; `['vehicle']` for all vehicle types; `[]` (empty) monitors all enabled classes.

#### Required AI Model Files

Place model files in `server/models/`:

```
server/models/
├── yolov8n.onnx          # Primary detection model (person + vehicles)
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
- Enabled classes: **person (0)**, bicycle (1), car (2), motorcycle (3), bus (5), truck (7)
- Confidence threshold: **0.45** (configurable via `CONFIDENCE_THRESHOLD` env)
- NMS IoU threshold: **0.5** (configurable via `NMS_IOU_THRESHOLD` env)
- Post-processing: NMS → filter enabled classes → scale boxes to actual JPEG frame size
- Frame dimensions: parsed from JPEG SOF marker (`getJpegSize`) — no full decode required; fallback to 640×640

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
  "frameWidth": 1920,
  "frameHeight": 1080,
  "detections": [
    {
      "objectId": 7,
      "confidence": 0.891,
      "bbox": { "x": 120, "y": 85, "width": 65, "height": 190 },
      "className": "person",
      "isLoitering": false,
      "dwellTime": 12.4,
      "zoneId": "zone-uuid-or-null"
    },
    {
      "objectId": 12,
      "confidence": 0.762,
      "bbox": { "x": 400, "y": 200, "width": 180, "height": 120 },
      "className": "car",
      "isLoitering": false,
      "dwellTime": 0,
      "zoneId": null
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

## 7. Per-Channel AI Module Selection

Each camera zone can independently activate one or more AI analysis modules via the `targetClasses` checkbox array in the Zone Editor. Modules are applied only to objects detected within that zone.

### 7.1 Available AI Modules (per Zone)

| # | Checkbox | Zone Key | RFP | Status | Description |
|:---:|---|---|---|:---:|---|
| 1 | ☑ **Human** | `human` | [AI-01](RFP_AI_Human_Detection.md) | ✅ 구현 완료 | 사람 감지 — YOLOv8n COCO class 0 (person) |
| 2 | ☑ **Vehicle** | `vehicle` | [AI-02](RFP_AI_Vehicle_Detection.md) | ✅ 구현 완료 | 차량 감지 — bicycle/car/motorcycle/bus/truck |
| 3 | ☑ **Face** | `face` | [AI-03](RFP_AI_Face_Recognition.md) | ✅ 구현 완료 | 얼굴 감지 — SCRFD-2.5G (3.2MB) + ArcFace ResNet50 Re-ID (249MB) |
| 4 | ☑ **Mask** | `mask` | [AI-04](RFP_AI_Mask_Detection.md) | ✅ 구현 완료 | 마스크 착용 감지 — YOLOv8m PPE (99MB), mask/no_mask 2-class |
| 5 | ☑ **Color** | `color` | [AI-05](RFP_AI_Color_Analysis.md) | ✅ 구현 완료 | 상/하의 색상 분석 — Phase-1 픽셀 평균, 11색 분류 (모델 불필요) |
| 6 | ☐ **Cloth** | `cloth` | [AI-06](RFP_AI_Cloth_Analysis.md) | 🔲 준비중 | 의류 유형 분류 — OpenPAR (openpar.onnx 미설치) |
| 7 | ☑ **Hat** | `hat` | [AI-07](RFP_AI_Hat_Detection.md) | ✅ 구현 완료 | 헬멧/모자 감지 — YOLOv8m PPE (99MB), hardhat/no_hardhat 분류 |
| 8 | ☑ **Accessories** | `accessories` | [AI-08](RFP_AI_Accessories_Detection.md) | ✅ 구현 완료 | 소품 감지 — YOLOv8n COCO (backpack/umbrella/handbag/tie/suitcase) |

> **구현 완료** 모듈은 Zone 편집 시 체크박스가 활성화됩니다. **준비중** 모듈은 체크박스가 회색으로 표시되며 해당 ONNX 모델 파일이 `server/models/`에 배치되면 자동 활성화됩니다.
>
> 체크박스 가용성은 서버 `/api/capabilities` 엔드포인트에서 실시간으로 조회됩니다.

### 7.2 Zone Editor UI — AI 감지 대상 체크박스

Zone 편집 화면 하단의 **"AI 감지 대상"** 섹션에서 해당 Zone에 적용할 AI 모듈을 선택합니다.

```
┌─────────────────────────────────┐
│ AI 감지 대상  (미선택 시 전체)   │
├────────────────┬────────────────┤
│ ☑ 사람         │ ☑ 차량         │
│ ☑ 얼굴         │ ☑ 마스크        │
│ ☑ 색상         │ ☐ 의류   준비중 │
│ ☑ 모자         │ ☑ 소품          │  ← 모두 활성 (의류만 준비중)
└────────────────┴────────────────┘
```

- **체크 선택**: 파란색 배경 + 체크 아이콘, 즉시 API 저장 (PUT `/api/cameras/:id/zones/:zoneId`)
- **미선택 시**: `targetClasses: []` → 모든 활성 클래스 감지 (기본 동작)
- **준비중 항목**: 비활성(회색), "준비중" 뱃지 표시, 클릭 불가
- **가용성 동적 조회**: Zone Editor 열릴 때 `/api/capabilities` 호출 → 모델 파일 존재 여부 반영

### 7.3 `targetClasses` 동작 규칙

```javascript
// behaviorEngine.js — classMatchesZone()
const TARGET_CLASS_MAP = {
  human:   ['person'],
  vehicle: ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  // 향후 추가: face, mask, color, cloth, hat, accessories
};

// targetClasses가 비어있으면 모든 클래스 허용
if (!targetClasses || targetClasses.length === 0) return true;
```

| `targetClasses` 설정 | 감지 대상 | 사용 사례 |
|---|---|---|
| `[]` (기본) | 모든 활성 클래스 | 일반 감시 |
| `["human"]` | 사람만 | 출입 통제 구역 |
| `["vehicle"]` | 차량만 | 주차장 관리 |
| `["human", "vehicle"]` | 사람 + 차량 | 혼합 구역 |
| `["human", "hat"]` | 사람 + 안전모 검사 | 건설 현장 컴플라이언스 *(준비중)* |
| `["human", "mask"]` | 사람 + 마스크 | 방역 구역 *(준비중)* |

### 7.4 Bounding Box 색상 코드 (화면 표시)

| 클래스 | 정상 색상 | Loitering 색상 |
|---|---|---|
| person | 🟢 녹색 `rgba(34,197,94)` | 🔴 빨간색 `rgba(239,68,68)` |
| bicycle | 🟡 노란색 `rgba(250,204,21)` | 🔴 빨간색 |
| car | 🔵 파란색 `rgba(59,130,246)` | 🔴 빨간색 |
| motorcycle | 🟠 주황색 `rgba(249,115,22)` | 🔴 빨간색 |
| bus | 🟣 보라색 `rgba(168,85,247)` | 🔴 빨간색 |
| truck | 🩵 청록색 `rgba(20,184,166)` | 🔴 빨간색 |

라벨 형식: `person #3  94%` (className + objectId + confidence)

### 7.5 향후 AI 모듈 활성화 절차

준비중 모듈은 해당 ONNX 모델 파일을 `server/models/`에 배치하면 자동 활성화됩니다:

```
server/models/
├── yolov8n.onnx                     # ✅ 현재 사용 중
├── scrfd_500m.onnx                  # Face/Head 감지 (AI-03, AI-07 공유)
├── arcface_r18.onnx                 # 얼굴 인식 Re-ID (AI-03)
├── mask_classifier_effb0.onnx       # 마스크 분류 (AI-04)
├── color_upper_efficientb0.onnx     # 상의 색상 (AI-05)
├── color_lower_efficientb0.onnx     # 하의 색상 (AI-05)
├── cloth_classifier_efficientb0.onnx # 의류 유형 (AI-06)
├── hat_classifier.onnx              # 모자/헬멧 분류 (AI-07)
└── accessories_yolov8n.onnx         # 소품 감지 (AI-08)
```

각 AI 모듈 상세 사양: `RFP_AI_Human_Detection.md` ~ `RFP_AI_Accessories_Detection.md` 참고.

---

## 8. Loitering Detection Logic

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

- Zones defined as polygons in pixel coordinates (actual JPEG frame space)
- Point-in-polygon test (ray casting) per detection per frame
- Up to **50 zones** per camera feed
- Zone types: `MONITOR` (trigger alerts), `EXCLUDE` (suppress alerts)
- Time-based activation: cron-style schedule per zone
- **Per-zone AI target class filtering** via `targetClasses` field:
  - `[]` or omitted → monitor all enabled detection classes
  - `['human']` → monitor persons only
  - `['vehicle']` → monitor bicycle/car/motorcycle/bus/truck
  - `['human', 'vehicle']` → monitor both
- Filter is applied per frame in the behavior engine — no restart required

---

## 9. React Web UI

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

### 8.3 Zone Editor

The Zone Editor opens as a full-viewport overlay when the **+ Zone** button is clicked on any camera view.

**Key implementation details:**

| Feature | Implementation |
|---|---|
| Full-screen vertex drag | Global `document.addEventListener('mousemove/mouseup')` — drag works even when cursor leaves the canvas |
| Coordinate system | All hit-testing uses frame pixel space; hit radius dynamically converted from screen pixels via `fwEff/fhEff` |
| Frame dimensions | Background image `naturalWidth/naturalHeight` (read via `onLoad`) replaces JPEG SOF defaults — matches `<img object-contain>` layout exactly |
| Vertex delete | Right-click on vertex → context menu shows "꼭짓점 N 삭제"; auto-saves after deletion; minimum 3 vertices enforced |
| AI target classes | Checkbox grid (Human, Vehicle, + 6 planned attributes) auto-saves per toggle via PUT API |

**Zone polygon storage:** coordinates are in actual JPEG frame pixel space (e.g. 1920×1080), not normalized. The ZoneEditor reads `img.naturalWidth/naturalHeight` so the canvas overlay always aligns with the displayed video regardless of container size.

### 8.4 Camera Management

- Auto-populate discovered cameras from UDP broadcast
- Manual RTSP URL entry
- Per-camera: start/stop stream, zone configuration, sensitivity settings

### 8.5 Fullscreen Camera View with Real-Time Detection Panel

Double-clicking any camera cell in the grid opens a fullscreen overlay with a dedicated left-side detection panel.

**Trigger:** Double-click on any camera cell in the multi-camera grid  
**Exit:** Click the × button, press `Escape`, or click the dimmed background

**Layout:**

```
┌──────────────────────────────────────────────────────────────────┐
│                         [Camera Name]                     [✕]   │
├─────────────────┬────────────────────────────────────────────────┤
│  Detections  3  │                                                │
│  1 loiter       │                                                │
├─────────────────┤                                                │
│ PERSON  #a3b2c1 │         Live Video (fullscreen)               │
│ [LOITER]        │         <img> + <canvas> overlay               │
│ conf  89%       │                                                │
│ dwell  42.3s    │         Bounding boxes drawn with              │
│ x 320  y 180    │         class colors + loitering               │
│ w  65  h 190    │         highlight (same as grid view)          │
├─────────────────┤                                                │
│ CAR     #f1e2d3 │                                                │
│ conf  74%       │                                                │
│ dwell   2.1s    │                                                │
│ x 800  y 400    │                                                │
│ w 120  h  80    │                                                │
├─────────────────┤                                                │
│ ■ person  ■ car │                                                │
│ ■ bicycle ■ bus │                                                │
└─────────────────┴────────────────────────────────────────────────┘
```

**Detection Panel fields (per object):**

| Field | Description |
|---|---|
| `className` | Object class (person, car, bicycle, …) — color-coded |
| `objectId` | Persistent track ID (8-char hex prefix) |
| `[LOITER]` badge | Shown in red when `isLoitering = true` |
| `conf` | Detection confidence (%) |
| `dwell` | Seconds the object has been in a monitored zone; yellow when > 5 s |
| `x, y` | Bounding box top-left in frame pixel coordinates |
| `w, h` | Bounding box width / height in pixels |

Objects are sorted: loitering first, then by descending dwell time.

**Socket.IO subscription reference counting:**

The fullscreen view renders an additional `useCamera(cameraId)` hook for the same camera.  
A module-level `subscriptionCounts` map ensures `camera:subscribe` is emitted only on the **first** subscriber and `camera:unsubscribe` only when the **last** subscriber unmounts — preventing the grid cell from losing its stream when the fullscreen modal closes.

---

## 10. Submodules

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

## 11. Technical Requirements

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

## 12. Functional Requirements

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

## 13. Non-Functional Requirements

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

## 14. Project Milestones & Deliverables

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

## 15. Getting Started

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

## 16. API Reference

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
| `POST` | `/api/cameras/:id/zones` | Create zone |
| `PUT` | `/api/cameras/:id/zones/:zoneId` | Update zone (polygon, name, targetClasses, etc.) |
| `DELETE` | `/api/cameras/:id/zones/:zoneId` | Delete zone |
| `GET` | `/api/events` | List loitering events |
| `GET` | `/api/events/:id/clip` | Download event video clip |

### 15.2 Zone Schema

```json
{
  "id": "uuid",
  "cameraId": "cam-01",
  "name": "Entry Zone",
  "type": "MONITOR",
  "polygon": [{"x": 100, "y": 150}, {"x": 400, "y": 150}, {"x": 400, "y": 500}, {"x": 100, "y": 500}],
  "dwellThreshold": 30,
  "minDisplacement": 50,
  "reentryWindow": 120,
  "targetClasses": ["human"],
  "active": true
}
```

`targetClasses` values: `"human"` (person), `"vehicle"` (bicycle/car/motorcycle/bus/truck). Empty array `[]` = all classes.

### 15.3 Socket.IO Events

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

## 17. Appendix

### Appendix A: Glossary

| Term | Definition |
|---|---|
| **Loitering** | Remaining in a location longer than a configured threshold without apparent purpose |
| **ObjectId** | Persistent UUID assigned to a tracked object across frames by ByteTrack |
| **Confidence** | Detection confidence score (0.0–1.0) from YOLOv8n for each bounding box |
| **Bounding Box** | Rectangle `{x, y, width, height}` in pixel coordinates enclosing a detected object |
| **ByteTrack** | Multi-object tracking algorithm using low-confidence detections for occlusion recovery |
| **RTSP** | Real Time Streaming Protocol — standard for IP camera video streaming |
| **ONVIF** | Open Network Video Interface Forum — IP camera interoperability standard |
| **WiseNet** | Hanwha Vision brand for IP cameras and surveillance equipment |
| **SUNAPI** | Samsung/Hanwha camera HTTP API for camera control |
| **UDP Broadcast** | Network broadcast to 255.255.255.255 for device discovery on LAN |
| **MOT** | Multi-Object Tracking — tracking multiple objects simultaneously across frames |
| **NMS** | Non-Maximum Suppression — removes duplicate detection boxes |
| **ONNX** | Open Neural Network Exchange — cross-platform AI model format |
| **targetClasses** | Per-zone array of AI detection targets: `human`, `vehicle`, and planned attributes |
| **JPEG SOF** | Start-of-Frame JPEG marker — used to extract image dimensions without full decode |
| **fwEff / fhEff** | Effective frame width/height in ZoneEditor — read from `img.naturalWidth/Height` to match `object-contain` layout |

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
