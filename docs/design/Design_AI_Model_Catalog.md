---
**Document:** Design_AI_Model_Catalog  
**Version:** 2.0  
**Status:** Draft  
**Date:** 2026-07-09  
**Parent SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Parent TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
**Implementation:** `server/src/routes/analysisApi.js`, `server/src/scripts/downloadModels.js`  
---

# Design — AI Model Catalog & Runtime Model Switching

## 1. Overview

`analysisApi.js` maintains two static catalog arrays — `MODEL_CATALOG` (YOLO detector, 20 entries) and `EXTENDED_CATALOG` (every other ONNX model family, 8 entries) — concatenated into `ALL_MODELS`. Each family's "currently active" model is tracked against a different in-memory service (`_detector`, `AttributePipeline._face/_ppe/_color`, `FireSmokeService`, `AppearanceReidService`), resolved centrally by `_activeFileForEntry()`. Operators can query the full catalog, download/export any automatable entry, and hot-swap the active model per family via REST APIs — all surfaced through the Admin Dashboard's AI Models tab.

## 2. Architecture

```
ALL_MODELS = [...MODEL_CATALOG, ...EXTENDED_CATALOG]   (28 entries)

MODEL_CATALOG (20 entries) — YOLO detector, family: undefined
  ├─ YOLO26 (n/s/m/l/x) — .pt from v8.4.0 → ultralytics export → ONNX
  ├─ YOLOv8 (n/s/m/l/x) — direct ONNX from Ultralytics v0.0.0
  ├─ YOLO11 (n/s/m/l/x) — direct ONNX from Ultralytics v8.3.0
  └─ YOLO12 (n/s/m/l/x) — .pt from v8.4.0 → ultralytics export → ONNX

EXTENDED_CATALOG (8 entries) — non-detector families
  ├─ family:'face-detection'   — SCRFD 2.5G            — direct ONNX
  ├─ family:'face-recognition' — ArcFace ResNet50       — direct ONNX
  ├─ family:'ppe'              — YOLOv8m PPE            — hfExport (HuggingFace .pt → ultralytics export)
  ├─ family:'fire-smoke'       — YOLOv8s Fire & Smoke   — hfExport (HuggingFace .pt → ultralytics export)
  ├─ family:'cloth-par'        — OpenPAR                — manualOnly (no automatable source)
  ├─ family:'human-parsing'  ×2 — SCHP LIP-20, SegFormer B2 Clothes — direct ONNX (Proposed)
  └─ family:'appearance-reid'  — OSNet person Re-ID     — direct ONNX (Proposed)

_downloadProgress: Map<modelId, { status, percent, error }>
  └─ status: 'downloading' | 'converting' | 'done' | 'error'

Active-model pointers, one per family (resolved by _activeFileForEntry(m, detectorActiveFile)):
  _detector                              (family: undefined — YOLO detector)
  AttributePipeline._face.scrfdPath      (family: 'face-detection')
  AttributePipeline._face.arcfacePath    (family: 'face-recognition')
  AttributePipeline._ppe.modelPath       (family: 'ppe')
  FireSmokeService.modelPath             (family: 'fire-smoke')
  AttributePipeline._color.parModelPath  (family: 'cloth-par')
  AttributePipeline._color.hpModelPath   (family: 'human-parsing')
  AppearanceReidService.modelPath        (family: 'appearance-reid')
  └─ all hot-swapped independently by POST /api/analysis/models/switch
```

## 3. MODEL_CATALOG Schema

```javascript
{
  id:                 string,   // e.g. 'yolo26n'
  label:              string,   // e.g. 'YOLO26n'
  series:             string,   // 'YOLO26' | 'YOLOv8' | 'YOLO11' | 'YOLO12'
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

### YOLO26 모델 벤치마크 (COCO val2017 mAP50-95)

| ID | mAP | CPU (ms) | T4 (ms) | Params | FLOPs |
|---|---|---|---|---|---|
| yolo26n | 40.9 | 38.9 | 1.7 | 2.4M | 5.4B |
| yolo26s | 48.6 | 87.2 | 2.5 | 9.5M | 20.7B |
| yolo26m | 53.1 | 220.0 | 4.7 | 20.4M | 68.2B |
| yolo26l | 55.0 | 286.2 | 6.2 | 24.8M | 86.4B |
| yolo26x | 57.5 | 525.8 | 11.8 | 55.7M | 193.9B |

Download URL 패턴: `https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26{n,s,m,l,x}.pt`

## 3b. EXTENDED_CATALOG Schema (non-detector families)

```javascript
{
  id:                 string,   // e.g. 'yolov8m-ppe'
  label:              string,   // e.g. 'YOLOv8m PPE (Mask+Helmet)'
  family:             string,   // 'face-detection' | 'face-recognition' | 'ppe' | 'fire-smoke'
                                 // | 'cloth-par' | 'human-parsing' | 'appearance-reid'
  series:             string,   // display grouping, e.g. 'PPE Detection'
  file:               string,   // ONNX filename in server/models/
  size?:              number,   // input size, when applicable (e.g. 640)
  url?:               string,   // direct ONNX download URL (mutually exclusive with hfExport/manualOnly)
  hfExport?:          { repo: string, file: string },  // huggingface_hub .pt → ultralytics export
  manualOnly?:        true,     // no automatable source — operator must export manually
  docRef?:            string,   // reference link shown by the UI/API when manualOnly
  classMap?:          object,   // human-parsing only — model-specific class indices → upper/lower
  inputSize?:         number,   // human-parsing only — native square input resolution
  license:            string,
}
```

`url`, `classMap`, and `hfExport` are stripped from the `GET /api/analysis/models` response (`FR-MC-005c`) — they are source-resolution detail, not needed by the client.

Exactly one of `url` / `hfExport` / `manualOnly` is set per entry, selecting the download strategy in §4.

| family | id | source strategy |
|---|---|---|
| `face-detection` | `scrfd-2.5g` | `url` (direct ONNX) |
| `face-recognition` | `arcface-w600k-r50` | `url` (direct ONNX) |
| `ppe` | `yolov8m-ppe` | `hfExport` (`keremberke/yolov8m-protective-equipment-detection`, `best.pt`) |
| `fire-smoke` | `yolov8s-fire-smoke` | `hfExport` (`Mehedi-2-96/fire-smoke-detection-yolo`, `fire_smoke_yolov8s_model.pt`) |
| `cloth-par` | `openpar-market1501` | `manualOnly` (OpenPAR has no public pretrained ONNX) |
| `human-parsing` | `schp-lip20`, `segformer-clothes` | `url` (direct ONNX) |
| `appearance-reid` | `osnet-retail-0287` | `url` (direct ONNX) |

## 4. Download Pipeline

### 4.1 Direct ONNX (YOLOv8, YOLO11, SCRFD, ArcFace, human-parsing, appearance-reid)

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

### 4.2 PT→ONNX Conversion (YOLO26, YOLO12)

```
POST /api/analysis/models/download { modelId: 'yolo26n' }  (YOLO26 예시, YOLO12도 동일)
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

### 4.2b HuggingFace .pt → ONNX Conversion (PPE, Fire & Smoke)

```
POST /api/analysis/models/download { modelId: 'yolov8m-ppe' }  (PPE 예시, Fire & Smoke도 동일)
  │
  ├─ pyExec = _findPythonWithUltralytics({ checkHfHub: true })
  │   → verifies `import ultralytics, huggingface_hub` (not the YOLO12 cfg check)
  ├─ _downloadProgress.set(modelId, { status:'converting', percent:50 })
  │
  ├─ execFile(pyExec, ['-c', '
  │     from ultralytics import YOLO
  │     from huggingface_hub import hf_hub_download
  │     import shutil
  │     pt = hf_hub_download(repo_id="<entry.hfExport.repo>", filename="<entry.hfExport.file>")
  │     YOLO(pt).export(format="onnx", imgsz=640, simplify=True)
  │     onnx = pt.replace(".pt", ".onnx")
  │     shutil.copy(onnx, "<filePath>")
  │   '], timeout: 300_000ms)
  │
  └─ _downloadProgress.set(modelId, { status:'done', percent:100 })
```

No `.pt` file is ever written into `server/models/` for this path — `hf_hub_download` caches it in the HuggingFace cache directory, and only the exported ONNX is copied out via `shutil.copy`.

### 4.2c Manual-Only Rejection (cloth-PAR / OpenPAR)

```
POST /api/analysis/models/download { modelId: 'openpar-market1501' }
  │
  └─ entry.manualOnly === true → 409 {
       error: 'No public pretrained ONNX exists for this model — export it manually and place the file in server/models/.',
       docRef: 'https://github.com/Event-AHU/OpenPAR',
     }
```

This check runs before the already-downloaded and download-in-progress checks — a `manualOnly` entry always rejects the download request, even if the file happens to already exist (the file's presence in that case came from a manual export, not this endpoint).

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
  ├─ find entry in ALL_MODELS; 400 if not found
  ├─ check filePath exists (server/models/<file>); 409 if missing
  │
  └─ switch (entry.family) {
       case 'human-parsing':    AttributePipeline._color.reloadHumanParsing(filePath, classMap, inputSize)
       case 'appearance-reid':  AppearanceReidService.reload(filePath)          (construct if absent)
       case 'face-detection':   AttributePipeline._face.reloadDetector(filePath)
       case 'face-recognition': AttributePipeline._face.reloadRecognizer(filePath)
       case 'ppe':              AttributePipeline._ppe.reload(filePath)
       case 'fire-smoke':       FireSmokeService.reload(filePath)               (construct if absent)
       case 'cloth-par':        AttributePipeline._color.reloadPar(filePath)
       default (undefined):     _detector.reload(filePath)                     (construct if absent)
     }
  └─ return { ok: true, active: entry.label, file: entry.file }
```

- Each family branch that depends on `AttributePipeline` returns HTTP 409 `{ error: 'AttributePipeline not loaded' }` if it hasn't finished its eager startup load yet.
- Every `reload()`/`reloadDetector()`/`reloadRecognizer()`/`reloadPar()`/`reloadHumanParsing()` method fully loads the new ONNX `InferenceSession` before replacing the service's active session/path — the previous session keeps serving in-flight inference until the swap completes.
- Families are fully independent: switching the active PPE model does not touch `_detector`, the active face model, etc. — `_activeFileForEntry()` (§6) reads back the correct per-family pointer.

## 6. GET /api/analysis/models Response

```javascript
GET /api/analysis/models → 200
{
  activeFile: 'yolov8n.onnx',
  catalog: [
    {
      id: 'yolo12n',
      label: 'YOLO12n',
      series: 'YOLO12',
      mAP: 40.6,
      cpuMs: 58.0,
      t4Ms: 1.6,
      params: '2.6M',
      flops: '6.5B',
      file: 'yolo12n.onnx',
      exists: false,
      active: false,
      sizeBytes: null,
      downloading: false,
      converting: false,
      downloadPercent: null,
      downloadError: null,
    },
    // ... 19 more detector entries (YOLO26/YOLO12/YOLO11/YOLOv8 × n/s/m/l/x)
    {
      id: 'yolov8m-ppe',
      label: 'YOLOv8m PPE (Mask+Helmet)',
      family: 'ppe',
      series: 'PPE Detection',
      file: 'yolov8m_ppe.onnx',
      license: 'See Hugging Face model card',
      exists: true,
      active: true,
      sizeBytes: 52428800,
      downloading: false,
      converting: false,
      downloadPercent: null,
      downloadError: null,
    },
    {
      id: 'openpar-market1501',
      label: 'OpenPAR (manual export)',
      family: 'cloth-par',
      series: 'Cloth Attribute (PAR)',
      file: 'openpar.onnx',
      manualOnly: true,
      docRef: 'https://github.com/Event-AHU/OpenPAR',
      license: 'See OpenPAR repository',
      exists: true,
      active: true,
      sizeBytes: 41943040,
      downloading: false,
      converting: false,
      downloadPercent: null,
      downloadError: null,
    },
    // ... 6 more extended-catalog entries (face-detection/face-recognition/fire-smoke ×1,
    //     human-parsing ×2, appearance-reid ×1)
  ]
}
```

## 7. Batch Download Script

`server/src/scripts/downloadModels.js` provides a CLI tool for pre-downloading models:

- `DIRECT_MODELS` array — direct-ONNX models (YOLOv8n, SCRFD, ArcFace enabled by default; human-parsing/appearance-reid entries disabled by default — Proposed, verify source before enabling)
- `YOLO12_MODELS` array — same 5 YOLO12 entries; uses same Python detection logic
- `exportYolo12ToOnnx(m)` — same GitHub-release PT→ONNX pipeline as the API handler's `requiresConversion` path
- `HF_EXPORT_MODELS` array — PPE and Fire & Smoke entries
- `exportHfPtToOnnx(m)` — same huggingface_hub PT→ONNX pipeline as the API handler's `hfExport` path (§4.2b)
- `PYTHON_EXPORT_INSTRUCTIONS` — printed manual-export instructions for OpenPAR only (the only model with no automatable source)

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

If none set, auto-detect falls back to `/usr/bin/python3` → `python3` → `python`. `_findPythonWithUltralytics({ checkYolo12, checkHfHub })` (analysisApi.js) and `_findPython(candidates, checkScript)` (downloadModels.js) share this candidate order but vary the verification script (`checkYolo12` for YOLO26/12, `checkHfHub` for PPE/Fire-Smoke).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — MODEL_CATALOG 구조, 다운로드 파이프라인, 런타임 전환, YOLO12 PT→ONNX 설계 |
| 1.1 | 2026-06-23 | YOLO26 시리즈(n/s/m/l/x) 추가 — 카탈로그 20개, PT→ONNX 파이프라인 공유 |
| 2.0 | 2026-07-09 | 전체 모델 파일로 범위 확대 — EXTENDED_CATALOG에 face-detection/face-recognition/ppe/fire-smoke/cloth-par 5개 패밀리 추가(카탈로그 총 28개), hfExport(HuggingFace .pt→ONNX) 및 manualOnly 다운로드 전략 신설(§4.2b, §4.2c), family별 독립 active 판정(`_activeFileForEntry()`)·switch 디스패치 재설계(§5), `{already:true}` 단축 응답 실제 구현 반영, §6 샘플 응답을 실제 `catalog`/`exists` 스키마로 정정 |
