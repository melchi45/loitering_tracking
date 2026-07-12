---
**Document:** Design_AI_Model_Catalog  
**Version:** 2.1  
**Status:** Draft  
**Date:** 2026-07-12  
**Parent SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Parent TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
**Implementation:** `server/src/routes/analysisApi.js`, `server/src/services/colorClothService.js`, `server/src/scripts/downloadModels.js`  
---

# Design — AI Model Catalog & Runtime Model Switching

## 1. Overview

`analysisApi.js` maintains two static catalog arrays — `MODEL_CATALOG` (YOLO detector, 20 entries) and `EXTENDED_CATALOG` (every other ONNX model family, 9 entries) — concatenated into `ALL_MODELS`. Each family's "currently active" model is tracked against a different in-memory service (`_detector`, `AttributePipeline._face/_ppe/_color`, `FireSmokeService`, `AppearanceReidService`), resolved centrally by `_activeFileForEntry()`. Operators can query the full catalog, download/export any automatable entry, and hot-swap the active model per family via REST APIs — all surfaced through the Admin Dashboard's AI Models tab. The `cloth-par` family exposes two selectable models (PromptPAR vs. OpenPAR — see §9); PromptPAR carries a pre-activation memory gate that the other families do not.

## 2. Architecture

```
ALL_MODELS = [...MODEL_CATALOG, ...EXTENDED_CATALOG]   (29 entries)

MODEL_CATALOG (20 entries) — YOLO detector, family: undefined
  ├─ YOLO26 (n/s/m/l/x) — .pt from v8.4.0 → ultralytics export → ONNX
  ├─ YOLOv8 (n/s/m/l/x) — direct ONNX from Ultralytics v0.0.0
  ├─ YOLO11 (n/s/m/l/x) — direct ONNX from Ultralytics v8.3.0
  └─ YOLO12 (n/s/m/l/x) — .pt from v8.4.0 → ultralytics export → ONNX

EXTENDED_CATALOG (9 entries) — non-detector families
  ├─ family:'face-detection'   — SCRFD 2.5G            — direct ONNX
  ├─ family:'face-recognition' — ArcFace ResNet50       — direct ONNX
  ├─ family:'ppe'              — YOLOv8m PPE            — hfExport (HuggingFace .pt → ultralytics export)
  ├─ family:'fire-smoke'       — YOLOv8s Fire & Smoke   — hfExport (HuggingFace .pt → ultralytics export)
  ├─ family:'cloth-par'      ×2 — PromptPAR (PA100k, CLIP ViT-L, shipped) + OpenPAR (ResNet50, PA100k, manualOnly) — see §9
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
| `cloth-par` | `openpar-pa100k` | none (`.onnx` shipped directly in `server/models/` — no public download URL, see §9) |
| `cloth-par` | `openpar-resnet50-pa100k` | `manualOnly` (OpenPAR ResNet50 baseline has no public pretrained ONNX) |
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
POST /api/analysis/models/download { modelId: 'openpar-resnet50-pa100k' }
  │
  └─ entry.manualOnly === true → 409 {
       error: 'No public pretrained ONNX exists for this model — export it manually and place the file in server/models/.',
       docRef: 'https://github.com/Event-AHU/OpenPAR',
     }
```

Note: `openpar-pa100k` (PromptPAR) is a `cloth-par` sibling entry that is NOT `manualOnly` — its `.onnx` is shipped directly in `server/models/` (no automated download source either, but the file is already present at install time, so `POST /models/download` for it simply short-circuits with `{ already: true }` per §4). `manualOnly` specifically marks entries with **no file present and no way to fetch one automatically** — currently only `openpar-resnet50-pa100k`.

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
       case 'cloth-par':        AttributePipeline._color.reloadPar(filePath)          (memory-gated for PromptPAR — see §9, throws 500 on gate failure)
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
      id: 'openpar-pa100k',
      label: 'PromptPAR (PA100k)',
      family: 'cloth-par',
      series: 'Cloth Attribute (PAR)',
      file: 'openpar_pa100k.onnx',
      docRef: 'https://github.com/Event-AHU/OpenPAR',
      license: 'See OpenPAR repository',
      exists: true,
      active: true,
      sizeBytes: 1288490188,
      downloading: false,
      converting: false,
      downloadPercent: null,
      downloadError: null,
    },
    {
      id: 'openpar-resnet50-pa100k',
      label: 'OpenPAR (ResNet50, PA100k)',
      family: 'cloth-par',
      series: 'Cloth Attribute (PAR)',
      file: 'openpar_resnet50_pa100k.onnx',
      manualOnly: true,
      docRef: 'https://github.com/Event-AHU/OpenPAR',
      license: 'See OpenPAR repository',
      exists: false,
      active: false,
      sizeBytes: null,
      downloading: false,
      converting: false,
      downloadPercent: null,
      downloadError: null,
    },
    // ... 5 more extended-catalog entries (face-detection/face-recognition/fire-smoke ×1,
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

## 8. Cloth-PAR Model Choice & PromptPAR Memory Gate

The `cloth-par` family (AI-06 Cloth Analysis) offers two admin-selectable models sharing the same PA100k 26-attribute taxonomy, implemented in `server/src/services/colorClothService.js`:

| Model | Catalog id | Backbone | Execution provider | Memory-gated? |
|---|---|---|---|---|
| PromptPAR (PA100k) | `openpar-pa100k` | CLIP ViT-L + text-prompt fusion (~1.2GB) | Forced CPU (`forceCpu: true` — DirectML triggers `DXGI_ERROR_DEVICE_REMOVED` during inference on this backbone) | **Yes** |
| OpenPAR (ResNet50, PA100k) | `openpar-resnet50-pa100k` | Plain ResNet50 classifier head | Default execution provider selection | No |

Both are selected the same way as every other family: Admin Dashboard → AI Models → **Cloth Attribute (PAR)** → **Activate** on the desired row (only enabled once the corresponding `.onnx` file exists in `server/models/`).

### 8.1 Why PromptPAR needs a gate

PromptPAR's CLIP ViT-L backbone is forced onto the CPU execution provider (table above), which means the ~1.2GB checkpoint plus ONNX Runtime's session buffers/activations all compete with the rest of the Node process for system RAM instead of GPU VRAM. Loading it when free RAM is already low risks an OS-level OOM kill of the whole server process — a much worse failure mode than simply refusing to activate the model. OpenPAR's ResNet50 head has no such backbone and is never gated.

### 8.2 Gate check

`colorClothService.js`:

```javascript
const PROMPTPAR_MIN_FREE_MEM_MB = Number(process.env.PROMPTPAR_MIN_FREE_MEM_MB) || 2048;
const PROMPTPAR_GATED_FILENAMES = new Set(['openpar_pa100k.onnx']);

function checkPromptParMemory() {
  const freeMB = Math.round(os.freemem() / (1024 * 1024));
  return { ok: freeMB >= PROMPTPAR_MIN_FREE_MEM_MB, freeMB, requiredMB: PROMPTPAR_MIN_FREE_MEM_MB };
}
```

The gate is keyed off the checkpoint's filename (only `openpar_pa100k.onnx` is gated), not a generic "is this a big file" heuristic — OpenPAR's ResNet50 file is exempt by construction. `PROMPTPAR_MIN_FREE_MEM_MB` is overridable via `server/.env` for hardware with different headroom characteristics.

### 8.3 Where the gate runs

| Call site | When | On gate failure |
|---|---|---|
| `ColorClothService.load()` | Server startup, if `openpar_pa100k.onnx` already exists on disk | Logs the reason, calls `analyticsConfig.setConfig({ cloth: false })`, skips loading — `_parReady` stays `false`. No exception (startup must not crash). |
| `ColorClothService.reloadPar(filePath)` | `POST /api/analysis/models/switch { modelId: 'openpar-pa100k' }` (hot-swap) | Same logging + `cloth: false` side effect, then **throws** — the route's existing `catch` block turns this into HTTP 500 `{ error: <message> }`, surfaced in the Admin Dashboard's error banner. |

Log line (both call sites), Korean per the project's operational logging convention:

```
[ColorClothService] PromptPAR 수행 불가능: 가용 메모리 부족 (free=1024MB < required=2048MB) — Cloth 분석을 비활성화합니다.
```

### 8.4 Why disable Cloth analysis rather than leave it stale

`analyticsConfig`'s `cloth` flag (default `false`) is what actually gates whether `attributePipeline.js` attaches a `cloth` field to detections (`config.cloth !== false`). If the gate blocks the PAR model from loading but `cloth` stayed `true`, the pipeline would keep expecting cloth-attribute output that never arrives — silently degrading rather than failing visibly. Turning `cloth` off keeps the Admin Dashboard's AI Analysis Modules toggle honest: it reflects whether cloth attribute enrichment can actually run, not just whether an operator once flipped it on.

### 8.5 Non-goals

- The gate does not retry or poll — it is a one-shot check at load/switch time. An operator who frees RAM and clicks Activate again re-triggers the check.
- The gate does not attempt to estimate exact PromptPAR runtime memory usage; `PROMPTPAR_MIN_FREE_MEM_MB` is a fixed operational floor, not a computed prediction.
- Switching to OpenPAR when PromptPAR is memory-gated is a manual operator action (Activate the other row) — there is no automatic fallback-to-OpenPAR behavior.

## 9. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PYTHON_EXEC` | — | Primary Python interpreter path |
| `PYTHON_EXEC_LINUX` | — | Linux-specific override (may lack `_lzma`) |
| `PYTHON_EXEC_WINDOWS` | — | Windows-specific override |
| `PROMPTPAR_MIN_FREE_MEM_MB` | `2048` | PromptPAR memory gate floor (MB free RAM) — see §8 |

If none set, auto-detect falls back to `/usr/bin/python3` → `python3` → `python`. `_findPythonWithUltralytics({ checkYolo12, checkHfHub })` (analysisApi.js) and `_findPython(candidates, checkScript)` (downloadModels.js) share this candidate order but vary the verification script (`checkYolo12` for YOLO26/12, `checkHfHub` for PPE/Fire-Smoke).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — MODEL_CATALOG 구조, 다운로드 파이프라인, 런타임 전환, YOLO12 PT→ONNX 설계 |
| 1.1 | 2026-06-23 | YOLO26 시리즈(n/s/m/l/x) 추가 — 카탈로그 20개, PT→ONNX 파이프라인 공유 |
| 2.0 | 2026-07-09 | 전체 모델 파일로 범위 확대 — EXTENDED_CATALOG에 face-detection/face-recognition/ppe/fire-smoke/cloth-par 5개 패밀리 추가(카탈로그 총 28개), hfExport(HuggingFace .pt→ONNX) 및 manualOnly 다운로드 전략 신설(§4.2b, §4.2c), family별 독립 active 판정(`_activeFileForEntry()`)·switch 디스패치 재설계(§5), `{already:true}` 단축 응답 실제 구현 반영, §6 샘플 응답을 실제 `catalog`/`exists` 스키마로 정정 |
| 2.1 | 2026-07-12 | PromptPAR(PA100k) 통합 반영 — `cloth-par` 패밀리가 `openpar-pa100k`(PromptPAR, 직접 배포) + `openpar-resnet50-pa100k`(OpenPAR ResNet50, manualOnly) 2개 항목으로 확장(카탈로그 총 29개), §8 신설(PromptPAR 메모리 게이트: 가용 RAM 부족 시 로그 남기고 Cloth 분석 자동 비활성화), §3b/§4.2c/§6 샘플을 실제 id·파일명으로 정정(구 `openpar-market1501`/`openpar.onnx` placeholder 제거) |
