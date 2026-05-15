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
│  Source: https://huggingface.co/keremberke/yolov8m-fire-and-smoke-detection │
│                                                                             │
│  pip install ultralytics huggingface_hub                                    │
│                                                                             │
│  python3 << 'PYEOF'                                                         │
│  from ultralytics import YOLO                                               │
│  from huggingface_hub import hf_hub_download                                │
│  import shutil, os                                                          │
│                                                                             │
│  pt = hf_hub_download(                                                      │
│      repo_id="keremberke/yolov8m-fire-and-smoke-detection",                 │
│      filename="best.pt")                                                    │
│  YOLO(pt).export(format="onnx", imgsz=640, simplify=True)                  │
│  onnx = pt.replace(".pt", ".onnx")                                          │
│  dest = os.path.join("server/models", "yolov8s_fire_smoke.onnx")           │
│  shutil.copy(onnx, dest)                                                    │
│  print("Saved:", dest)                                                      │
│  PYEOF                                                                      │
│                                                                             │
│  Alternative (GitHub YOLOv8n — lighter):                                    │
│    https://github.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection               │
│    Download best.pt, export same way                                        │
│    Dataset: https://github.com/gaiasd/DFireDataset (21,000+ images)        │
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

  console.log(PYTHON_EXPORT_INSTRUCTIONS);
  printStatus();

  console.log(`\nDone: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
}

main().catch(console.error);
