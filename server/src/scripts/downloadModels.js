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
];

// ─── YOLO12 models (PT download → ultralytics ONNX export, automated) ────────
const YOLO12_MODELS = [
  { id: 'yolo12n', ptFile: 'yolo12n.pt', onnxFile: 'yolo12n.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12n.pt', size: '~5 MB PT' },
  { id: 'yolo12s', ptFile: 'yolo12s.pt', onnxFile: 'yolo12s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12s.pt', size: '~18 MB PT' },
  { id: 'yolo12m', ptFile: 'yolo12m.pt', onnxFile: 'yolo12m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12m.pt', size: '~40 MB PT' },
  { id: 'yolo12l', ptFile: 'yolo12l.pt', onnxFile: 'yolo12l.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12l.pt', size: '~53 MB PT' },
  { id: 'yolo12x', ptFile: 'yolo12x.pt', onnxFile: 'yolo12x.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12x.pt', size: '~118 MB PT' },
];

// Find Python that has ultralytics — PYTHON_EXEC_LINUX may lack _lzma so try /usr/bin/python3 as fallback.
const { execFileSync } = require('child_process');
const _pyCandidates = [
  process.env.PYTHON_EXEC,
  process.platform === 'win32' ? process.env.PYTHON_EXEC_WINDOWS : process.env.PYTHON_EXEC_LINUX,
  '/usr/bin/python3',
  'python3',
  'python',
].filter(Boolean);
let PYTHON_EXEC = null;
for (const cand of _pyCandidates) {
  try { execFileSync(cand, ['-c', 'import ultralytics'], { timeout: 5000, stdio: 'pipe' }); PYTHON_EXEC = cand; break; } catch {}
}
if (!PYTHON_EXEC) {
  console.warn('Warning: Python with ultralytics not found — YOLO12 export will fail. Run: pip install ultralytics');
  PYTHON_EXEC = 'python3';
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

// ─── Models requiring Python / ultralytics export ────────────────────────────
const PYTHON_EXPORT_INSTRUCTIONS = `
┌─────────────────────────────────────────────────────────────────────────────┐
│  Models requiring Python + ultralytics export                               │
├─────────────────────────────────────────────────────────────────────────────┤
│  AI-04 Mask Detection + AI-07 Helmet Detection                              │
│  Source: https://huggingface.co/keremberke/yolov8m-protective-equipment-detection
│                                                                             │
│  pip install ultralytics huggingface_hub                                    │
│                                                                             │
│  python3 << 'PYEOF'                                                         │
│  from ultralytics import YOLO                                               │
│  from huggingface_hub import hf_hub_download                                │
│  import shutil, os                                                          │
│                                                                             │
│  pt = hf_hub_download(                                                      │
│      repo_id="keremberke/yolov8m-protective-equipment-detection",           │
│      filename="best.pt")                                                    │
│  YOLO(pt).export(format="onnx", imgsz=640, simplify=True)                  │
│  onnx = pt.replace(".pt", ".onnx")                                          │
│  dest = os.path.join("server/models", "yolov8m_ppe.onnx")                  │
│  shutil.copy(onnx, dest)                                                    │
│  print("Saved:", dest)                                                      │
│  PYEOF                                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  AI-09 Fire & Smoke Detection                                               │
│  Source: https://huggingface.co/Mehedi-2-96/fire-smoke-detection-yolo       │
│          Classes: fire(0), other(1, skipped), smoke(2) — output [1,7,8400] │
│                                                                             │
│  pip install ultralytics huggingface_hub                                    │
│                                                                             │
│  python3 << 'PYEOF'                                                         │
│  from ultralytics import YOLO                                               │
│  from huggingface_hub import hf_hub_download                                │
│  import shutil, os                                                          │
│                                                                             │
│  pt = hf_hub_download(                                                      │
│      repo_id="Mehedi-2-96/fire-smoke-detection-yolo",                       │
│      filename="fire_smoke_yolov8s_model.pt")                                │
│  YOLO(pt).export(format="onnx", imgsz=640, simplify=True)                  │
│  onnx = pt.replace(".pt", ".onnx")                                          │
│  dest = os.path.join("server/models", "yolov8s_fire_smoke.onnx")           │
│  shutil.copy(onnx, dest)                                                    │
│  print("Saved:", dest)                                                      │
│  PYEOF                                                                      │
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

  console.log(PYTHON_EXPORT_INSTRUCTIONS);
  printStatus();

  console.log(`\nDone: ${downloaded} downloaded/converted, ${skipped} skipped, ${failed} failed`);
}

main().catch(console.error);
