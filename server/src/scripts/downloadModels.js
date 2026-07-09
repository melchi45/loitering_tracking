#!/usr/bin/env node
'use strict';

/**
 * LTS-2026 Model Downloader
 *
 * Downloads ONNX model files required for optional AI attribute modules.
 * Run from the server directory:
 *   node src/scripts/downloadModels.js
 *
 * Models requiring Python export (ultralytics) are described separately below.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const MODELS_DIR = path.resolve(__dirname, '..', '..', 'models');

// ─── Models downloadable directly as ONNX ────────────────────────────────────
const DIRECT_MODELS = [
  {
    file:    'yolov8n.onnx',
    url:     'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx',
    size:    '~12 MB',
    module:  'AI-01/02 Human+Vehicle Detection (required)',
    enabled: true,
  },
  {
    file:    'scrfd_2.5g.onnx',
    url:     'https://huggingface.co/JackCui/facefusion/resolve/main/scrfd_2.5g.onnx',
    size:    '3.3 MB',
    module:  'AI-03 Face Detection (SCRFD-2.5G)',
    enabled: true,
  },
  {
    file:    'arcface_w600k_r50.onnx',
    url:     'https://huggingface.co/FoivosPar/Arc2Face/resolve/da2f1e9aa3954dad093213acfc9ae75a68da6ffd/arcface.onnx',
    size:    '~166 MB',
    module:  'AI-03 Face Recognition (ArcFace ResNet50)',
    enabled: true,
  },
  // ── AI-05 Phase-3 (proposed, disabled by default) ──────────────────────────
  // Verify the source/license yourself before enabling — these are optional,
  // not yet wired into a required pipeline path. Set enabled:true to fetch.
  // Source: https://huggingface.co/pirocheto/schp-lip-20 (MIT license)
  // Input: pixel_values [1,3,473,473] float32 · Output: logits [1,20,473,473]
  // LIP-20 classes: 0 bg,1 hat,2 hair,3 glove,4 sunglasses,5 upper-clothes,
  //   6 dress,7 coat,8 socks,9 pants,10 jumpsuits,11 scarf,12 skirt,13 face,
  //   14 l-arm,15 r-arm,16 l-leg,17 r-leg,18 l-shoe,19 r-shoe
  {
    file:    'schp_lip.onnx',
    url:     'https://huggingface.co/pirocheto/schp-lip-20/resolve/main/onnx/schp-lip-20-int8-static.onnx',
    size:    '~68 MB (int8, self-contained)',
    module:  'AI-05 Phase-3 Human Parsing (SCHP LIP-20, Proposed — see docs/design/Design_AI_Color_Analysis.md §10)',
    enabled: false,
  },
  // Source: https://huggingface.co/Xenova/segformer_b2_clothes
  // (fine-tuned from nvidia/segformer-b2, NVIDIA SegFormer NC license —
  //  non-commercial only; acceptable for this non-commercial project)
  // Input: pixel_values [1,3,512,512] float32 · Output: logits [1,18,128,128]
  // (¼-resolution output — bilinear-upsample or downsample color buffer to match)
  // 18 classes: 0 bg,1 hat,2 hair,3 sunglasses,4 upper-clothes,5 skirt,6 pants,
  //   7 dress,8 belt,9 l-shoe,10 r-shoe,11 face,12 l-leg,13 r-leg,14 l-arm,
  //   15 r-arm,16 bag,17 scarf
  {
    file:    'segformer_clothes.onnx',
    url:     'https://huggingface.co/Xenova/segformer_b2_clothes/resolve/main/onnx/model_quantized.onnx',
    size:    '~29 MB (int8 quantized)',
    module:  'AI-05 Phase-3 Human Parsing alt. (SegFormer clothes, Proposed, non-commercial license)',
    enabled: false,
  },
  // Source: Intel Open Model Zoo — person-reidentification-retail-0287
  // (OSNet-family backbone, Apache 2.0)
  // Input: data [1,3,256,128] float32 BGR NCHW · Output: reid_embedding [1,256]
  {
    file:    'appearance_reid_osnet.onnx',
    url:     'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/person-reidentification-retail-0287/person-reidentification-retail-0267.onnx',
    size:    '~3.5 MB',
    module:  'CCFR Phase-2 Appearance Re-ID embedding (OSNet, Proposed — see docs/design/Design_AI_AppearanceReID.md §12)',
    enabled: false,
  },
];

// ─── YOLO12 models (PT download → ultralytics ONNX export, automated) ────────
const YOLO12_MODELS = [
  { id: 'yolo12n', ptFile: 'yolo12n.pt', onnxFile: 'yolo12n.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12n.pt', size: '~5 MB PT' },
  { id: 'yolo12s', ptFile: 'yolo12s.pt', onnxFile: 'yolo12s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12s.pt', size: '~18 MB PT' },
  { id: 'yolo12m', ptFile: 'yolo12m.pt', onnxFile: 'yolo12m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12m.pt', size: '~40 MB PT' },
  { id: 'yolo12l', ptFile: 'yolo12l.pt', onnxFile: 'yolo12l.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12l.pt', size: '~53 MB PT' },
  { id: 'yolo12x', ptFile: 'yolo12x.pt', onnxFile: 'yolo12x.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12x.pt', size: '~118 MB PT' },
];

// Find a Python interpreter satisfying `checkScript`, trying each candidate in order.
const { execFileSync } = require('child_process');
function _findPython(candidates, checkScript) {
  for (const cand of candidates) {
    try { execFileSync(cand, ['-c', checkScript], { timeout: 8000, stdio: 'pipe' }); return cand; } catch {}
  }
  return null;
}

const _pyCandidates = [
  process.env.PYTHON_EXEC,
  process.platform === 'win32' ? process.env.PYTHON_EXEC_WINDOWS : process.env.PYTHON_EXEC_LINUX,
  '/usr/bin/python3',
  'python3',
  'python',
].filter(Boolean);

// YOLO12/26: ultralytics < 8.3.x has no YOLO12 support; check explicitly (cfg/models/12 directory).
const PYTHON_EXEC = _findPython(_pyCandidates, [
  'import ultralytics, os',
  'cfg12 = os.path.join(os.path.dirname(ultralytics.__file__), "cfg", "models", "12")',
  'assert os.path.exists(cfg12), "YOLO12 not supported (ultralytics " + ultralytics.__version__ + ")"',
].join('; ')) || (() => {
  console.warn('Warning: Python with ultralytics >=8.3 (YOLO12 support) not found — YOLO12 export will fail. Run: pip install -U ultralytics');
  return 'python3';
})();

// PPE / Fire & Smoke: exported via huggingface_hub .pt download + ultralytics export.
const PYTHON_EXEC_HF = _findPython(_pyCandidates, 'import ultralytics, huggingface_hub');
if (!PYTHON_EXEC_HF) {
  console.warn('Warning: Python with ultralytics + huggingface_hub not found — PPE/Fire-Smoke auto-export will fail. Run: pip install -U ultralytics huggingface_hub');
}

// ─── PPE + Fire & Smoke (HuggingFace .pt download → ultralytics ONNX export, automated) ──
const HF_EXPORT_MODELS = [
  {
    id: 'yolov8m-ppe', onnxFile: 'yolov8m_ppe.onnx',
    hfRepo: 'keremberke/yolov8m-protective-equipment-detection', hfFile: 'best.pt',
    module: 'AI-04 Mask + AI-07 Helmet Detection',
  },
  {
    id: 'yolov8s-fire-smoke', onnxFile: 'yolov8s_fire_smoke.onnx',
    hfRepo: 'Mehedi-2-96/fire-smoke-detection-yolo', hfFile: 'fire_smoke_yolov8s_model.pt',
    module: 'AI-09 Fire & Smoke Detection',
  },
];

async function exportHfPtToOnnx(m) {
  const { execFile } = require('child_process');
  const onnxPath = path.join(MODELS_DIR, m.onnxFile);

  if (fs.existsSync(onnxPath)) {
    console.log(`  [SKIP] ${m.onnxFile} (already exists)`);
    return 'skipped';
  }
  if (!PYTHON_EXEC_HF) {
    console.log(`  [FAIL] ${m.onnxFile}: Python with ultralytics + huggingface_hub not found`);
    return 'failed';
  }

  console.log(`  Downloading + converting ${m.onnxFile} via huggingface_hub (${m.hfRepo})...`);
  const script = [
    'from ultralytics import YOLO',
    'from huggingface_hub import hf_hub_download',
    'import shutil',
    `pt = hf_hub_download(repo_id=${JSON.stringify(m.hfRepo)}, filename=${JSON.stringify(m.hfFile)})`,
    'YOLO(pt).export(format="onnx", imgsz=640, simplify=True)',
    'onnx = pt.replace(".pt", ".onnx")',
    `shutil.copy(onnx, ${JSON.stringify(onnxPath)})`,
  ].join('; ');

  await new Promise((resolve, reject) => {
    execFile(PYTHON_EXEC_HF, ['-c', script], { timeout: 300_000 }, (err, _out, stderr) => {
      if (err) { console.error('  export stderr:', stderr); return reject(err); }
      resolve();
    });
  });

  console.log(`  [OK] ${m.onnxFile}`);
  return 'converted';
}

async function exportYolo12ToOnnx(m) {
  const { execFile } = require('child_process');
  const ptPath   = path.join(MODELS_DIR, m.ptFile);
  const onnxPath = path.join(MODELS_DIR, m.onnxFile);

  if (fs.existsSync(onnxPath)) {
    console.log(`  [SKIP] ${m.onnxFile} (already exists)`);
    return 'skipped';
  }

  if (!fs.existsSync(ptPath)) {
    console.log(`  Downloading PT ${m.id} — ${m.size}`);
    await download(m.url, ptPath);
  } else {
    console.log(`  [SKIP] PT ${m.ptFile} already cached`);
  }

  console.log(`  Converting ${m.ptFile} → ${m.onnxFile} ...`);
  const script = [
    'from ultralytics import YOLO',
    `m = YOLO(${JSON.stringify(ptPath)})`,
    'm.export(format="onnx", imgsz=640, dynamic=False)',
  ].join('; ');

  await new Promise((resolve, reject) => {
    execFile(PYTHON_EXEC, ['-c', script], { timeout: 300_000 }, (err, _out, stderr) => {
      if (err) { console.error('  export stderr:', stderr); return reject(err); }
      resolve();
    });
  });

  const exportedOnnx = ptPath.replace(/\.pt$/, '.onnx');
  if (exportedOnnx !== onnxPath && fs.existsSync(exportedOnnx)) {
    fs.renameSync(exportedOnnx, onnxPath);
  }
  fs.unlink(ptPath, () => {});
  console.log(`  [OK] ${m.onnxFile}`);
  return 'converted';
}

// ─── Models with no automatable source — manual export only ──────────────────
// AI-04/AI-07 (PPE) and AI-09 (Fire & Smoke) are handled automatically above
// (HF_EXPORT_MODELS / exportHfPtToOnnx) and via the Admin Dashboard's AI Models
// UI (POST /api/analysis/models/download). OpenPAR has no public pretrained
// ONNX — the operator must train/export their own checkpoint.
const PYTHON_EXPORT_INSTRUCTIONS = `
┌─────────────────────────────────────────────────────────────────────────────┐
│  Models requiring a manually-exported checkpoint (no public pretrained ONNX) │
├─────────────────────────────────────────────────────────────────────────────┤
│  AI-05 Color + AI-06 Cloth (PAR multi-label attributes)                     │
│  Source: https://github.com/Event-AHU/OpenPAR                               │
│                                                                             │
│  git clone https://github.com/Event-AHU/OpenPAR                            │
│  # Follow OpenPAR README to train or download pre-trained weights           │
│  # Then export:                                                             │
│  python3 << 'PYEOF'                                                         │
│  import torch                                                               │
│  # Load your OpenPAR model checkpoint                                       │
│  model.eval()                                                               │
│  dummy = torch.randn(1, 3, 256, 128)                                        │
│  torch.onnx.export(model, dummy, "server/models/openpar.onnx",              │
│      input_names=["input"], output_names=["output"],                        │
│      opset_version=11)                                                      │
│  PYEOF                                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
`;

// ─── Download helper ──────────────────────────────────────────────────────────
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      console.log(`  [SKIP] ${path.basename(destPath)} (already exists)`);
      return resolve('skipped');
    }

    const tmp  = destPath + '.tmp';
    const file = fs.createWriteStream(tmp);
    let downloaded = 0;

    function get(u) {
      const proto = u.startsWith('https') ? https : http;
      const opts = {
        headers: { 'User-Agent': 'LTS-ModelDownloader/1.0' },
        rejectUnauthorized: false,
      };
      proto.get(u, opts, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.destroy();
          try { fs.unlinkSync(tmp); } catch (_) {}
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers['content-length'] || '0');
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total) {
            const pct = ((downloaded / total) * 100).toFixed(0);
            process.stdout.write(`\r  ${path.basename(destPath)}: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.renameSync(tmp, destPath);
          console.log(`\n  [OK] ${path.basename(destPath)}`);
          resolve('downloaded');
        });
      }).on('error', (err) => {
        file.destroy();
        try { fs.unlinkSync(tmp); } catch (_) {}
        reject(err);
      });
    }

    get(url);
  });
}

// ─── Status check ─────────────────────────────────────────────────────────────
function printStatus() {
  const ALL = [
    { file: 'yolov8n.onnx',            module: 'AI-01/02 Person+Vehicle (required)' },
    { file: 'scrfd_2.5g.onnx',         module: 'AI-03 Face Detection' },
    { file: 'arcface_w600k_r50.onnx',  module: 'AI-03 Face Recognition' },
    { file: 'yolov8m_ppe.onnx',        module: 'AI-04 Mask + AI-07 Helmet' },
    { file: 'openpar.onnx',            module: 'AI-05 Color + AI-06 Cloth' },
    { file: 'yolov8s_fire_smoke.onnx', module: 'AI-09 Fire & Smoke Detection' },
    { file: 'schp_lip.onnx',            module: 'AI-05 Phase-3 Human Parsing (SCHP, Proposed)' },
    { file: 'segformer_clothes.onnx',   module: 'AI-05 Phase-3 Human Parsing alt. (SegFormer, Proposed)' },
    { file: 'appearance_reid_osnet.onnx', module: 'CCFR Phase-2 Appearance Re-ID (OSNet, Proposed)' },
    ...YOLO12_MODELS.map(m => ({ file: m.onnxFile, module: `YOLO12 Detection (${m.id})` })),
  ];
  console.log('\n=== Model Status ===');
  for (const m of ALL) {
    const ok = fs.existsSync(path.join(MODELS_DIR, m.file));
    console.log(`  ${ok ? '✓' : '✗'} ${m.file.padEnd(30)} ${m.module}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });

  console.log('=== LTS-2026 Model Downloader ===\n');

  let downloaded = 0, skipped = 0, failed = 0;

  for (const m of DIRECT_MODELS) {
    if (!m.enabled) continue;
    console.log(`Downloading [${m.module}] — ${m.size}`);
    try {
      const result = await download(m.url, path.join(MODELS_DIR, m.file));
      if (result === 'skipped') skipped++; else downloaded++;
    } catch (e) {
      console.error(`  [FAIL] ${e.message}`);
      failed++;
    }
  }

  // YOLO12: automated PT download + ONNX export
  console.log('\n=== YOLO12 Models (PT → ONNX auto-export) ===\n');
  for (const m of YOLO12_MODELS) {
    try {
      const result = await exportYolo12ToOnnx(m);
      if (result === 'skipped') skipped++; else downloaded++;
    } catch (e) {
      console.error(`  [FAIL] ${m.id}: ${e.message}`);
      failed++;
    }
  }

  // PPE + Fire & Smoke: automated HuggingFace .pt download + ONNX export
  console.log('\n=== PPE / Fire & Smoke Models (HuggingFace → ONNX auto-export) ===\n');
  for (const m of HF_EXPORT_MODELS) {
    try {
      const result = await exportHfPtToOnnx(m);
      if (result === 'skipped') skipped++;
      else if (result === 'failed') failed++;
      else downloaded++;
    } catch (e) {
      console.error(`  [FAIL] ${m.id}: ${e.message}`);
      failed++;
    }
  }

  console.log(PYTHON_EXPORT_INSTRUCTIONS);
  printStatus();

  console.log(`\nDone: ${downloaded} downloaded/converted, ${skipped} skipped, ${failed} failed`);
}

main().catch(console.error);
