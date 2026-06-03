# DESIGN DOCUMENT
# LTS-2026 Loitering Tracking System — System Architecture

| | |
|---|---|
| **Document ID** | DESIGN-LTS-MAIN-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_LTS2026_Loitering_Tracking_System.md |

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Component Map](#2-component-map)
3. [Server — Video Ingestion Layer](#3-server--video-ingestion-layer)
4. [Server — AI Inference Layer](#4-server--ai-inference-layer)
5. [Server — Tracking Layer](#5-server--tracking-layer)
6. [Server — Behavior & Zone Layer](#6-server--behavior--zone-layer)
7. [Server — Alert & Storage Layer](#7-server--alert--storage-layer)
8. [Server — API & Real-Time Layer](#8-server--api--real-time-layer)
9. [Client — React Dashboard](#9-client--react-dashboard)
10. [MCP Server — LLM Integration](#10-mcp-server--llm-integration)
11. [Data Flow Diagrams](#11-data-flow-diagrams)
12. [Database Design](#12-database-design)
13. [Configuration & Deployment](#13-configuration--deployment)
14. [Cross-Cutting Concerns](#14-cross-cutting-concerns)

---

## 1. System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                          LTS-2026 System Architecture                             │
│                                                                                    │
│  ┌─────────────────┐  ┌──────────────────────────────────────────────────────┐   │
│  │   IP Cameras    │  │               MCP Client Layer                        │   │
│  │  (RTSP/ONVIF)  │  │  Claude Code │ Claude API │ OpenAI Agents │ ChatGPT   │   │
│  └────────┬────────┘  └───────────────────────┬──────────────────────────────┘   │
│           │ RTSP                               │ MCP (stdio / HTTP SSE)           │
│  ┌────────▼──────────────────────────────────▼──────────────────────────────┐   │
│  │                         SERVER PROCESS  (port 3080)                        │   │
│  │                                                                             │   │
│  │  ┌───────────────┐  ┌────────────────┐  ┌──────────────┐                 │   │
│  │  │Video Ingestion │  │  Detection     │  │  Attribute   │                 │   │
│  │  │PipelineManager │→│  YOLOv8n ONNX  │→│  Pipeline    │                 │   │
│  │  │RTSPCapture     │  │  detection.js  │  │  Face/PPE/   │                 │   │
│  │  │YouTubeSvc      │  │  640×640 NMS   │  │  Color/Cloth │                 │   │
│  │  └───────────────┘  └────────────────┘  └──────┬───────┘                 │   │
│  │                                                  │ enriched objects        │   │
│  │  ┌────────────────────────────────────────────▼──────────────────────┐   │   │
│  │  │                    TRACKING LAYER                                   │   │   │
│  │  │  ByteTracker ── KalmanFilter  ── 5-cue scoring (IoU+Face+Color..)  │   │   │
│  │  │  tracking.js  +  8-dim KF       trackerConfig.js                   │   │   │
│  │  └────────────────────────────────┬───────────────────────────────────┘   │   │
│  │                                   │ tracked objects { objectId, bbox, .. } │   │
│  │  ┌────────────────────────────────▼───────────────────────────────────┐   │   │
│  │  │                  BEHAVIOR & ZONE LAYER                              │   │   │
│  │  │  BehaviorEngine ── ZoneManager ── AlertService                      │   │   │
│  │  │  behaviorEngine.js  zoneManager.js  alertService.js                │   │   │
│  │  │  riskScore, pacing  MONITOR/EXCLUDE  dedup + persist               │   │   │
│  │  └────────────────────┬───────────────────────────────────────────────┘   │   │
│  │                       │ loitering events, alerts                           │   │
│  │  ┌────────────────────▼───────────────────────────────────────────────┐   │   │
│  │  │                   API & REAL-TIME LAYER                             │   │   │
│  │  │  Express REST API  +  Socket.IO v4  +  WebRTC Gateway (mediasoup)   │   │   │
│  │  │  index.js / api/     streamHandler.js  webrtcGateway.js            │   │   │
│  │  └────────────────────┬────────────────────────────────────────────────┘   │   │
│  │                       │                                                     │   │
│  │  ┌────────────────────▼────────┐   ┌──────────────────────────────────┐   │   │
│  │  │  Storage — db.js            │   │  MCP Server (separate process)    │   │   │
│  │  │  lts.json (JSON file DB)    │   │  mcp-server/index.js             │   │   │
│  │  │  cameras, zones, events,    │   │  10 tools + 4 resources           │   │   │
│  │  │  alerts, faceGalleries      │   │  → LTS API via HTTP fetch         │   │   │
│  │  └─────────────────────────────┘   └──────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                       CLIENT  (React 18 + TypeScript)                        │   │
│  │  App.tsx ── Socket.IO client ── Camera Grid ── Zone Editor ── Alert Panel   │   │
│  │  Face ID Tab ── Video Analytics Sidebar ── i18n (15 languages)              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Map

### 2.1 Server Components

| Component | File(s) | Responsibility |
|---|---|---|
| PipelineManager | `services/pipelineManager.js` | Orchestrates per-camera pipeline: video → detect → enrich → track → behavior → emit |
| RTSPCapture | `services/rtspCapture.js` | FFmpeg-based RTSP stream decode; emits JPEG frames |
| YouTubeStreamService | `services/youtubeStreamService.js` | yt-dlp URL resolution; forwards to RTSPCapture |
| detection.js | `services/detection.js` | YOLOv8n ONNX inference; letterbox pre/post processing |
| AttributePipeline | `services/attributePipeline.js` | Composes FaceService, PPEService, ColorClothService |
| FaceService | `services/faceService.js` | SCRFD-2.5G face detection + ArcFace embedding |
| PPEService | `services/protectiveEquipService.js` | Hat + mask detection (YOLOv8m PPE ONNX) |
| ColorClothService | `services/colorClothService.js` | Dominant color + clothing type extraction |
| FireSmokeService | `services/fireSmokeService.js` | YOLOv8s fire/smoke detection (optional model) |
| ByteTracker | `services/tracking.js` | Multi-object tracker (IoU Hungarian + 5-cue scoring) |
| KalmanFilter | `services/tracking.js` | 8-dim state estimator embedded in `Track` class |
| trackerConfig | `services/trackerConfig.js` | Singleton: Kalman + appearance weight params; persisted to `tracker.json` |
| BehaviorEngine | `services/behaviorEngine.js` | Dwell time, pacing score, circular score, composite riskScore |
| ZoneManager | `services/zoneManager.js` | Zone CRUD; point-in-polygon; MONITOR/EXCLUDE evaluation |
| AlertService | `services/alertService.js` | Deduplication; persist alert; trigger notifications |
| WebRTC Gateway | `services/webrtcGateway.js` | mediasoup-based WebRTC SFU for browser-based live video |
| DiscoveryService | `services/discoveryService.js` | ONVIF camera autodiscovery on the local network |
| db.js | `db.js` | JSON-file database abstraction; CRUD on `lts.json` tables |

### 2.2 API Router Components

| Router | File | Endpoints |
|---|---|---|
| camerasRouter | `api/cameras.js` | Camera CRUD + pipeline start/stop |
| zonesRouter | `api/zones.js` | Zone CRUD (nested under cameras) |
| eventsRouter | `api/events.js` | Event query + alert CRUD |
| analyticsRouter | `api/analytics.js` | Analytics aggregation |
| trackerRouter | `api/tracker.js` | Tracker config read/write/reset |
| youtubeStreamsRouter | `api/youtubeStreams.js` | YouTube stream management |
| faceGalleryRouter | `api/faceGallery.js` | Gallery and face enrollment |
| internalRouter | `api/internal.js` | Internal service endpoints |

### 2.3 Socket.IO Handler Components

| Handler | File | Events |
|---|---|---|
| streamHandler | `socket/streamHandler.js` | `detections`, `loitering_alert`, `detections:summary`, `face_match`, `face:reidentified` |
| webrtcSignaling | `socket/webrtcSignaling.js` | WebRTC offer/answer/ICE signaling |

### 2.4 Client Components

| Component | File | Description |
|---|---|---|
| App | `client/src/App.tsx` | Root; Socket.IO connection; global event listeners |
| CameraGrid | `client/src/components/CameraGrid.tsx` | Multi-camera live view with annotation overlays |
| ZoneEditor | `client/src/components/ZoneEditorOverlay.tsx` | Drag-and-drop polygon canvas editor |
| AlertPanel | `client/src/components/AlertsPanel.tsx` | Real-time alert log with acknowledge controls |
| FaceGalleryTab | `client/src/components/FaceGalleryTab.tsx` | Gallery CRUD, enrollment, live match log |
| VideoAnalyticsTab | `client/src/components/VideoAnalyticsTab.tsx` | Tracker config sliders; appearance weights |
| FullscreenCameraView | `client/src/components/FullscreenCameraView.tsx` | Expanded single-camera view with detection panel |

---

## 3. Server — Video Ingestion Layer

### 3.1 Pipeline Lifecycle

```
PipelineManager.startCamera(cameraId)
  │
  ├── Load camera from DB
  ├── Construct RTSPCapture or YouTubeStreamService
  ├── Create per-camera instances:
  │     ByteTracker, BehaviorEngine, ZoneManager (reference)
  │
  └── RTSPCapture.on('frame', async (jpegBuffer, width, height, timestamp) => {
        await pipelineManager._processFrame(cameraId, jpegBuffer, width, height, timestamp)
      })
```

### 3.2 `_processFrame` Execution Order

```
1. detection.js.detect(jpegBuffer)         → raw detections []
2. Fast color extraction (pixel avg)       → det.color added per person
3. tracker.update(rawDetections)           → tracked objects [] (5-cue score uses frame N-1 attrs)
4. attributePipeline.enrich(tracked, ...)  → face embedding, PPE, color, cloth
5. tracker.updateAppearance(id, ...)       → store attrs for frame N+1
6. behaviorEngine.update(tracked, zones)   → dwell, riskScore, isLoitering per object
7. io.to(cameraId).emit('detections', ...) → per-frame emit to subscribed clients
8. loitering check → alertService.create() → io.emit('loitering_alert', ...)
9. io.to(cameraId).emit('detections:summary', ...)
```

### 3.3 Frame Rate Control

- RTSPCapture targets approximately 10 FPS for AI processing.
- Raw stream FPS may be higher; frames are dropped when the pipeline queue is non-empty.
- `timestamp` is a Unix millisecond value attached to each emitted frame.

---

## 4. Server — AI Inference Layer

### 4.1 YOLOv8n Detection Pipeline

```
Input: JPEG Buffer (original resolution)
  │
  ├── decode to raw pixels
  ├── resize to width=640 (aspect-ratio preserved)  → e.g. 640×480
  ├── letterbox pad to 640×640 (grey=0.5)
  ├── convert to float32 [1,3,640,640] NCHW
  │
  ▼ ONNX InferenceSession.run()
  │
  ├── output: [1, 84, 8400] (YOLOv8 output format)
  ├── NMS: IoU threshold 0.50
  ├── coordinate remap: letterbox inverse → original resolution
  └── Output: [{ class, classId, confidence, bbox: {x,y,width,height} }]
```

### 4.2 Attribute Pipeline Composition

```
AttributePipeline.enrich(trackedObjects, jpegBuffer, frameW, frameH)
  │
  ├── FaceService (if enabled):
  │     detectFaces(jpeg, w, h) → face bboxes + landmarks
  │     getEmbedding(jpeg, bbox) → Float32Array(512) L2-normalized
  │
  ├── PPEService (if yolov8m_ppe.onnx present):
  │     Per person bbox → head crop → hat/mask classification
  │
  ├── ColorClothService (if openpar.onnx present or builtin):
  │     Per person bbox → upper/lower body crop → dominant color + cloth type
  │
  └── FireSmokeService (if yolov8s_fire_smoke.onnx present):
        Full frame inference → fire/smoke bboxes
```

### 4.3 ONNX Session Configuration

Each model loaded with `onnxOptions.js` settings:

| Mode | `intraOpNumThreads` | Providers |
|---|---|---|
| Development (`NODE_ENV=development`) | `ONNX_THREADS_DEV` (default 1) | `['cpu']` |
| CUDA (`ONNX_CUDA=1`) | `ONNX_THREADS_CUDA` (default 1) | `['cuda', 'cpu']` |
| Production | Auto: `max(2, min(8, cores/2))` | `['cpu']` |

---

## 5. Server — Tracking Layer

### 5.1 KalmanFilter State Machine

```
State vector: [x, y, w, h, vx, vy, vw, vh]

Track.init(bbox):
  x = [bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, 0, 0]
  P = I(8) × 10,   Q = I(8) × 1,   R = I(4) × 10

Track.predict():                            (called every frame)
  x = F · x    (F: 8×8 with velocity offsets)
  P = F·P·F^T + Q
  → adaptive Q scaling based on velocity and occlusion state

Track.update(measuredBbox):                 (called when matched)
  K = P·H^T · (H·P·H^T + R)^{-1}
  x = x + K · (z - H·x)
  P = (I - K·H) · P
```

### 5.2 ByteTracker Assignment

```
Frame N:
  1. Predict all active tracks (KF.predict())
  2. Fast color extraction on raw detections
  3. Build IoU cost matrix: tracks × detections
     For each pair: compute 5-cue score
       → skip if class mismatch (score = -1)
  4. Hungarian algorithm on cost matrix
  5. High-confidence detections (conf > threshold): Stage 1 assignment
  6. Remaining detections + lost tracks: Stage 2 assignment
  7. Unmatched detections → new tracks
  8. Unmatched active tracks → mark lost (increment framesWithoutHit)
  9. Lost tracks exceeding maxAge → prune
```

### 5.3 5-Cue Association Score

```javascript
score(det, track) =
  Σ( λ_k × sim_k(det, track) ) / Σ( λ_k  for active cues k )

// Active cue determination:
//   IoU:   always active (λ=0.60)
//   Face:  track.embedding && det.embedding (requires face model on, λ=0.20)
//   Color: color model enabled; fast pixel avg pre-computed (λ=0.12)
//   Cloth: openpar.onnx loaded; both track.cloth and det.cloth set (λ=0.05)
//   Acc:   PPE model enabled; both track.accessories and det.accessories set (λ=0.03)
```

---

## 6. Server — Behavior & Zone Layer

### 6.1 BehaviorEngine Per-Object State

```javascript
// Per objectId, per zone:
{
  zoneEntryTime:    timestamp,         // when object entered zone
  positionHistory:  [{x,y,t}],        // up to 300 entries
  revisitCount:     number,
  lastExitTime:     timestamp,
  dwellTime:        number (seconds),
  riskScore:        number [0,1],
  isLoitering:      boolean,
  pacingScore:      number [0,1],
  circularScore:    number [0,1],
  velocity:         number (px/s),
}
```

### 6.2 Risk Score Components

| Component | Formula | Weight |
|---|---|---|
| Dwell ratio | `min(dwellTime / dwellThreshold, 1)` | 0.35 |
| Revisit ratio | `min(revisitCount / 5, 1)` | 0.30 |
| Low velocity | `max(0, 1 − velocity / 80)` | 0.15 |
| Pacing score | `min(xReversals / 10, 1)` | 0.12 |
| Circular score | `1 − displacement / pathLength` | 0.08 |

### 6.3 ZoneManager Point-in-Polygon

```javascript
// Ray-casting algorithm (O(n) per point, n = polygon vertices)
isPointInPolygon(point, polygon):
  inside = false
  for each edge (pi, pj) of polygon:
    if ray from point crosses edge: toggle inside
  return inside
```

Zone evaluation per frame per object:
1. Check point-in-polygon for object centroid.
2. If `EXCLUDE` zone → skip all detection/behavior logic for this object.
3. If `MONITOR` zone → apply dwell + risk logic.
4. Check zone schedule → skip if outside active window.
5. Check `targetClasses` → skip if object class not in list.

---

## 7. Server — Alert & Storage Layer

### 7.1 AlertService Flow

```
BehaviorEngine emits isLoitering=true for objectId in zoneId
  │
  ├── AlertService.createAlert(cameraId, objectId, zoneId, dwellTime, riskScore)
  │     ├── Deduplication: check if unacknowledged alert exists for same (objectId, zoneId)
  │     │   If exists: skip (cooldown not expired)
  │     ├── Create loitering event record → db.insert('events', event)
  │     ├── Create alert record → db.insert('alerts', alert)
  │     └── io.emit('loitering_alert', alertPayload)
  │
  └── Notification pipeline (Phase 4):
        email, webhook, VMS integration
```

### 7.2 DB Module (`db.js`) Interface

```javascript
class DB {
  find(table, query)       → records[]
  findOne(table, query)    → record | null
  insert(table, record)    → record (with id, createdAt, updatedAt auto-set)
  update(table, id, data)  → record | null
  delete(table, id)        → boolean
}
// Backed by lts.json; all writes are synchronous JSON serialization
```

---

## 8. Server — API & Real-Time Layer

### 8.1 Express App Bootstrap (`index.js`)

```javascript
// Startup order:
webrtcGateway.init()              // mediasoup workers
db = initDB()                     // load lts.json
app = express() + http.createServer(app)
io  = new SocketIOServer(httpServer)

// Mount routes
app.use('/api/cameras', ...)
app.use('/api/cameras/:id/zones', zonesRouter(zoneManager))
app.use('/api/events', eventsRouter)
app.use('/api/alerts', alertsRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/tracker', trackerRouter)
app.use('/api/galleries', faceGalleryRouter)
app.use('/api/youtube-streams', ...)

// Socket.IO handlers
registerStreamHandlers(io, pipelineManager)
registerWebRTCHandlers(io, webrtcGateway)

httpServer.listen(PORT)
```

### 8.2 CORS Configuration

```javascript
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
```

### 8.3 WebRTC Gateway (mediasoup)

The WebRTC gateway provides browser-based live video streaming:
- mediasoup creates a Router and WebRTC Transport per client.
- Signaling (offer/answer/ICE) over Socket.IO events.
- ICE configuration served from `GET /api/webrtc/ice-config` (STUN/TURN from `.env`).

---

## 9. Client — React Dashboard

### 9.1 Component Architecture

```
App.tsx
├── Socket.IO singleton setup (window.__ltsSocket)
├── Global event listeners:
│     face:reidentified → useCrossCameraStore
│     face_match → propagate to FaceGalleryTab
│
├── Sidebar
│   ├── CameraList (useCameraStore)
│   ├── AlertsPanel (useAlertStore)
│   ├── FaceGalleryTab (FR-FAC-050..057)
│   └── VideoAnalyticsTab (tracker config)
│
└── Main content
    ├── CameraGrid (multi-camera live view)
    │     └── CameraCard × N
    │           ├── Canvas overlay (bboxes, track IDs, risk badges)
    │           └── onClick → FullscreenCameraView
    └── FullscreenCameraView
          ├── Video feed (WebRTC or MJPEG)
          ├── Detection panel (per-object list)
          └── Zone editor overlay
```

### 9.2 State Management (Zustand stores)

| Store | Data | Source |
|---|---|---|
| `useCameraStore` | Camera list, pipeline status | `GET /api/cameras` + Socket.IO events |
| `useAlertStore` | Active alerts | `GET /api/alerts` + `loitering_alert` events |
| `useCrossCameraStore` | Recent cross-camera Re-ID events (last 20, 60s TTL) | `face:reidentified` Socket.IO |
| `useTrackerConfigStore` | Kalman + appearance weight params | `GET /api/tracker/config` |

### 9.3 Socket.IO Client Pattern

```typescript
// App.tsx singleton
const socket = io('http://localhost:3080');
(window as any).__ltsSocket = socket;   // global ref for child components

socket.on('detections', (data) => { /* update per-camera bboxes */ });
socket.on('loitering_alert', (alert) => { /* push to alert store */ });
socket.on('face:reidentified', (event) => { crossCameraStore.add(event) });
socket.on('face_match', (match) => { /* propagate to FaceGalleryTab */ });
```

---

## 10. MCP Server — LLM Integration

The MCP server is a **separate Node.js process** in `mcp-server/`. It connects to the LTS REST API as a read-mostly client. For detailed design, see `Design_LLM_MCP_Server.md` (DESIGN-LTS-MCP-01).

### 10.1 Integration Points

| Direction | Interface | Description |
|---|---|---|
| LTS API → MCP | HTTP REST (port 3080) | MCP tools query live detection data |
| MCP → LLM Client | stdio or SSE (port 3002) | LLM receives tool responses |
| LTS Config → MCP | `LTS_BASE_URL` env var | Points to active LTS server |
| MCP → Claude Code | `.claude/settings.json` | Auto-registered as `lts` MCP server |
| MCP → VS Code | `.vscode/mcp.json` | Auto-registered as `lts` MCP server |

### 10.2 Write Operations from LLM

| MCP Tool | LTS REST Call | Effect |
|---|---|---|
| `acknowledge_alert` | `POST /api/alerts/:id/acknowledge` | Marks alert reviewed; removes from active list |
| `update_zone_threshold` | `PUT /api/cameras/:id/zones/:zoneId` | Adjusts zone sensitivity |

---

## 11. Data Flow Diagrams

### 11.1 Normal Detection Flow (No Alert)

```
Camera Feed
  │
  ▼ JPEG frame (10 FPS)
PipelineManager._processFrame()
  │ YOLOv8n detect
  ▼ [{bbox, class, conf}]
AttributePipeline.enrich()
  │ face embedding, color, hat, mask
  ▼ enriched detections
ByteTracker.update()
  │ 5-cue Hungarian assignment
  ▼ tracked [{objectId, bbox, riskScore≈0, isLoitering=false}]
BehaviorEngine.update()
  │ dwell<threshold, riskScore computed
  ▼ behavioral data per object
Socket.IO emit('detections', payload)
  │
  ▼ React Dashboard canvas overlay update
```

### 11.2 Loitering Alert Flow

```
PipelineManager._processFrame()
  │ ... (same as above) ...
  ▼ BehaviorEngine.update()
  │ dwellTime >= zone.dwellThreshold → isLoitering=true
  │ riskScore >= zone.minRiskScore
  ▼
AlertService.createAlert(cameraId, objectId, zoneId, dwellTime, riskScore)
  ├── db.insert('events', event)  → lts.json
  ├── db.insert('alerts', alert)  → lts.json
  └── io.emit('loitering_alert', alertPayload)
          │
          ├── Dashboard AlertPanel (immediate visual + audio notification)
          └── MCP lts://alerts/active (next resource read reflects new alert)
```

### 11.3 Cross-Camera Re-ID Flow

```
Camera A: frame N → FaceService.getEmbedding() → embedding E_A
  │
  ├── _sharedFaceGallery.search(E_A, threshold=0.35)
  │     Match found: faceId=F7, lastCameraId=CamA → same camera → no Re-ID event
  │
Camera B: frame M → FaceService.getEmbedding() → embedding E_B
  │
  ├── _sharedFaceGallery.search(E_B, threshold=0.35)
  │     Match found: faceId=F7, lastCameraId=CamA ≠ CamB → Cross-camera!
  │     │
  │     ├── _bboxClose() match face bbox to person track → newObjectId=42
  │     ├── io.emit('face:reidentified', {faceId, prevCameraId, newCameraId, newObjectId, similarity})
  │     ├── _crossCameraStats[F7].transitionCount++
  │     └── _sharedFaceGallery[F7].lastCameraId = CamB
```

---

## 12. Database Design

### 12.1 `lts.json` Tables

All tables are stored as arrays in `storage/lts.json`. The `db.js` module provides CRUD operations.

**cameras**
```
id          UUID    Primary key
name        string  Display name
url         string  RTSP / YouTube URL
type        string  'rtsp' | 'youtube' | 'http'
aiEnabled   boolean Run AI detection pipeline
createdAt   ISO-8601
```

**zones**
```
id               UUID
cameraId         UUID (FK → cameras.id)
name             string
type             'MONITOR' | 'EXCLUDE'
polygon          [{x,y}]
dwellThreshold   number (seconds, default 30)
minDisplacement  number (pixels, default 50)
reentryWindow    number (seconds, default 120)
minRiskScore     number [0,1] (default 0.0)
targetClasses    string[]
schedule         {startTime, endTime, days}?
createdAt        ISO-8601
```

**events** (loitering occurrences)
```
id          UUID
cameraId    UUID
objectId    string (tracker UUID)
zoneId      UUID | null
zoneName    string | null
startTime   ISO-8601
dwellTime   number (seconds)
createdAt   ISO-8601
```

**alerts**
```
id           UUID
eventId      UUID (FK → events.id)
cameraId     UUID
objectId     string
zoneId       UUID | null
zoneName     string | null
type         'LOITERING'
dwellTime    number
timestamp    number (Unix ms)
acknowledged boolean (default false)
```

**faceGalleries**
```
id          UUID
name        string
description string
type        'general' | 'vip' | 'blocklist' | 'missing'
createdAt   ISO-8601
updatedAt   ISO-8601
```

**faceGalleryFaces**
```
id          UUID
galleryId   UUID (FK → faceGalleries.id)
name        string
embedding   number[512]  (never exposed via API)
thumbnail   string (data:image/jpeg;base64,...)
bbox        {x,y,width,height}
score       number (SCRFD confidence)
createdAt   ISO-8601
```

### 12.2 `storage/tracker.json`

```json
{
  "fastSpeedThreshold": 30,
  "fastQScale": 4.0,
  "slowSpeedThreshold": 5,
  "slowQScale": 0.5,
  "occlusionQScale": 3.0,
  "measurementNoise": 10,
  "iouWeight": 0.60,
  "faceWeight": 0.20,
  "colorWeight": 0.12,
  "clothWeight": 0.05,
  "accWeight": 0.03
}
```

---

## 13. Configuration & Deployment

### 13.1 Environment Variables (`server/.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server listen port |
| `NODE_ENV` | `development` | Determines ONNX thread mode |
| `ONNX_THREADS_DEV` | `1` | ONNX intra-op threads (development) |
| `ONNX_THREADS_PROD` | `0` | ONNX threads (0 = auto) |
| `ONNX_CUDA` | _(unset)_ | Enable CUDA ONNX provider |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs |
| `TURN_URL` | _(unset)_ | TURN server URL |
| `TURN_USERNAME` | _(unset)_ | TURN credentials |
| `TURN_CREDENTIAL` | _(unset)_ | TURN credentials |

### 13.2 Model Files (`server/models/`)

| File | Model | Size | Required |
|---|---|---|---|
| `yolov8n.onnx` | Primary detection (COCO 80-class) | ~12 MB | Yes |
| `scrfd_2.5g.onnx` | Face detection (SCRFD-2.5G) | ~3 MB | Optional |
| `arcface_w600k_r50.onnx` | Face recognition (ArcFace ResNet-50) | ~249 MB | Optional |
| `yolov8m_ppe.onnx` | Hat + mask detection | ~52 MB | Optional |
| `yolov8s_fire_smoke.onnx` | Fire/smoke detection | ~22 MB | Optional |
| `openpar.onnx` | Clothing type classification (PAR) | ~8 MB | Optional |

### 13.3 Deployment Topology

| Mode | Hardware | Notes |
|---|---|---|
| Development | Any x86_64 laptop/desktop, CPU only | `npm run dev`, 1 ONNX thread |
| Edge | NVIDIA Jetson Orin (ARM64, CUDA) | `ONNX_CUDA=1`, hardware decode |
| Server GPU | NVIDIA RTX 4090 / A100 | `ONNX_CUDA=1`, multi-camera |
| Cloud | AWS EC2 G4dn / Azure NC-series | Docker + env vars |

---

## 14. Cross-Cutting Concerns

### 14.1 Logging

- Server: `console.log` for info; `console.error` for errors. No structured logger currently.
- MCP Server: All output to `stderr` (stdout reserved for MCP protocol).

### 14.2 Error Handling Strategy

| Layer | Strategy |
|---|---|
| ONNX inference | Errors logged; frame skipped; pipeline continues |
| Per-frame processing | `try/catch` around `_processFrame`; camera pipeline not terminated |
| REST API | Express error handler returns `{ success: false, error: msg }` |
| DB write failures | Re-thrown; API returns 500 |
| Network errors (fetch) | Tools return `isError: true` |

### 14.3 Security Considerations (Production)

- TLS termination via reverse proxy (nginx + Let's Encrypt).
- CORS currently allows all origins (`*`); should be restricted to dashboard origin in production.
- Face embeddings never exposed via API responses; only 64×64 thumbnails.
- `MCP_AUTH_TOKEN` required for HTTP/SSE MCP transport in public deployments.

### 14.4 Scalability Path

| Scale Level | Architecture | Notes |
|---|---|---|
| 1–16 cameras, 1 server | Current (in-process, lts.json) | No external dependencies |
| 17–64 cameras, 1 server | Migrate DB to SQLite/PostgreSQL | `db.js` abstraction allows swap |
| Multi-server | Redis Stack for shared face gallery; PostgreSQL for events | See RFP §2.3.2 |
| Cloud / edge hybrid | Qdrant vector DB; S3 video storage | Phase 3+ |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for LTS2026 Loitering Tracking System |
