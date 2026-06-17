---
**Document:** Design_AI_Model_Catalog  
**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-06-17  
**Parent SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Parent TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
**Implementation:** `server/src/routes/analysisApi.js`, `server/src/scripts/downloadModels.js`  
---

# Design — AI Model Catalog & Runtime Model Switching

## 1. Overview

`analysisApi.js` maintains a static `MODEL_CATALOG` array and a module-level `_detector` variable pointing to the active `DetectionService` instance. Operators can query the catalog, download models, and hot-swap the active model via REST APIs.

## 2. Architecture

```
MODEL_CATALOG (static array, 15 entries)
  │
  ├─ YOLOv8 (n/s/m/l/x) — direct ONNX from Ultralytics v0.0.0
  ├─ YOLO11 (n/s/m/l/x) — direct ONNX from Ultralytics v8.3.0
  └─ YOLO12 (n/s/m/l/x) — .pt from v8.4.0 → ultralytics export → ONNX

_downloadProgress: Map<modelId, { status, percent, error }>
  └─ status: 'downloading' | 'converting' | 'done' | 'error'

_detector: DetectionService (current active model)
  └─ hot-swapped by POST /api/analysis/models/switch
```

## 3. MODEL_CATALOG Schema

```javascript
{
  id:                 string,   // e.g. 'yolo12n'
  label:              string,   // e.g. 'YOLO12n'
  series:             string,   // 'YOLOv8' | 'YOLO11' | 'YOLO12'
  size:               number,   // input size (640)
  mAP:                number,   // COCO val2017 mAP50-95
  cpuMs:              number,   // inference ms on Intel i7-9750H
  t4Ms:               number,   // inference ms on NVIDIA T4
  params:             string,   // parameter count (e.g. '2.6M')
  flops:              string,   // GFLOPs (e.g. '6.5B')
  file:               string,   // ONNX filename in server/models/
  url:                string,   // download URL (ONNX or .pt)
  requiresConversion: boolean,  // true for YOLO12 (PT→ONNX)
}
```

All entries produce output shape `[1, 84, 8400]` — compatible with `DetectionService._postprocess()` without modification.

## 4. Download Pipeline

### 4.1 Direct ONNX (YOLOv8, YOLO11)

```
POST /api/analysis/models/download { modelId }
  │
  ├─ already downloaded? → 200 { already: true }
  ├─ already downloading? → 409
  │
  ├─ _downloadProgress.set(modelId, { status:'downloading', percent:0 })
  ├─ doDownload(entry.url, filePath, callback)
  │   ├─ HTTP GET with redirect follow
  │   ├─ write to <filePath>.tmp
  │   ├─ progress: _downloadProgress.percent = received/total*100
  │   └─ rename .tmp → filePath on finish
  └─ _downloadProgress.set(modelId, { status:'done', percent:100 })
```

### 4.2 PT→ONNX Conversion (YOLO12)

```
POST /api/analysis/models/download { modelId: 'yolo12n' }
  │
  ├─ _downloadProgress.set(modelId, { status:'downloading', percent:0 })
  ├─ doDownload(entry.url, ptPath, callback)   ← downloads .pt file
  │
  ├─ _downloadProgress.set(modelId, { status:'converting', percent:95 })
  │
  ├─ Python auto-detection:
  │   candidates = [PYTHON_EXEC, PYTHON_EXEC_LINUX, '/usr/bin/python3', 'python3', 'python']
  │   for each: execFileSync(cand, ['-c', 'import ultralytics'], timeout:5s)
  │   → first success = pyExec
  │   (PYTHON_EXEC_LINUX may lack _lzma → import fails → /usr/bin/python3 used)
  │
  ├─ execFile(pyExec, ['-c', '
  │     from ultralytics import YOLO
  │     m = YOLO("<ptPath>")
  │     m.export(format="onnx", imgsz=640, dynamic=False)
  │   '], timeout: 300_000ms)
  │
  ├─ rename exported ONNX to server/models/<file>
  ├─ unlink ptPath
  └─ _downloadProgress.set(modelId, { status:'done', percent:100 })
```

### 4.3 Error Handling

```
Any error in download/conversion:
  _downloadProgress.set(modelId, { status:'error', percent:0, error: err.message })
  → logged, no server crash
```

## 5. Runtime Model Switch

```
POST /api/analysis/models/switch { modelId }
  │
  ├─ find entry in MODEL_CATALOG
  ├─ check filePath exists (server/models/<file>)
  ├─ const DetectionService = require('../services/detection')
  ├─ _detector = new DetectionService({ modelPath: filePath })
  │   └─ loads ONNX InferenceSession (blocking until ready)
  └─ return { modelId, label, modelPath }
```

- `_detector` replacement is atomic at the JavaScript assignment level.
- In-flight inference on the previous detector completes normally; the new detector handles subsequent frames.

## 6. GET /api/analysis/models Response

```javascript
GET /api/analysis/models → 200
{
  activeModelId: 'yolov8n',
  models: [
    {
      id: 'yolo12n',
      label: 'YOLO12n',
      series: 'YOLO12',
      mAP: 40.6,
      cpuMs: 58.0,
      t4Ms: 1.6,
      params: '2.6M',
      flops: '6.5B',
      downloaded: false,
      active: false,
      downloading: false,
      converting: false,
    },
    // ... 14 more entries
  ]
}
```

## 7. Batch Download Script

`server/src/scripts/downloadModels.js` provides a CLI tool for pre-downloading models:

- `DIRECT_MODELS` array — YOLOv8 base + face models (non-catalog, always-on)
- `YOLO12_MODELS` array — same 5 YOLO12 entries; uses same Python detection logic
- `exportYolo12ToOnnx(m)` — same PT→ONNX pipeline as the API handler

Usage:
```bash
cd server && node src/scripts/downloadModels.js
```

## 8. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PYTHON_EXEC` | — | Primary Python interpreter path |
| `PYTHON_EXEC_LINUX` | — | Linux-specific override (may lack `_lzma`) |
| `PYTHON_EXEC_WINDOWS` | — | Windows-specific override |

If none set, auto-detect falls back to `/usr/bin/python3` → `python3` → `python`.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — MODEL_CATALOG 구조, 다운로드 파이프라인, 런타임 전환, YOLO12 PT→ONNX 설계 |
