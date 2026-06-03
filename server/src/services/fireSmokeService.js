'use strict';

const fs   = require('fs');
const path = require('path');
const ort  = require('onnxruntime-node');
const sharp = require('sharp');
const { getOnnxSessionOptions } = require('../utils/onnxOptions');

const MODEL_SIZE     = 640;
const CONF_THRESHOLD = 0.35;
const NMS_THRESHOLD  = 0.45;

// Model classes mapped by index position (3-class output [1,7,8400])
// Index 1 ('other'/'default') is ignored — only fire and smoke are reported.
const CLASS_NAMES    = ['fire', 'default', 'smoke'];
const SKIP_CLASSES   = new Set(['default']);
// Normalise class names to lowercase for downstream consumers
const NORMALISE      = { Fire: 'fire', fire: 'fire', smoke: 'smoke', default: 'default' };

/**
 * Fire and Smoke detector using a YOLOv8s model fine-tuned on fire/smoke datasets.
 *
 * Model file: server/models/yolov8s_fire_smoke.onnx
 * Source: huggingface.co/Mehedi-2-96/fire-smoke-detection-yolo (fire_smoke_yolov8s_model.pt)
 *         Classes: fire(0), other(1, skipped), smoke(2)
 * Output shape: [1, 7, 8400]  (4 bbox + 3 class scores: fire / other / smoke)
 *
 * Download / export:
 *   python3 -c "
 *     from ultralytics import YOLO
 *     from huggingface_hub import hf_hub_download
 *     import shutil
 *     pt = hf_hub_download('keremberke/yolov8m-fire-and-smoke-detection', 'best.pt')
 *     YOLO(pt).export(format='onnx', imgsz=640, simplify=True)
 *     shutil.copy(pt.replace('.pt','.onnx'), 'server/models/yolov8s_fire_smoke.onnx')
 *   "
 */
class FireSmokeService {
  constructor(options = {}) {
    const modelsDir   = path.resolve(__dirname, '..', '..', 'models');
    this.modelPath    = options.modelPath || path.join(modelsDir, 'yolov8s_fire_smoke.onnx');
    this._session     = null;
    this._ready       = false;
    // 'not_started' | 'missing' | 'loaded' | 'failed'
    this._status      = 'not_started';
  }

  async load() {
    if (!fs.existsSync(this.modelPath)) {
      console.log('[FireSmokeService] yolov8s_fire_smoke.onnx not found — fire/smoke detection disabled');
      this._status = 'missing';
      return;
    }
    try {
      this._session = await ort.InferenceSession.create(this.modelPath, getOnnxSessionOptions());
      this._ready  = true;
      this._status = 'loaded';
      console.log('[FireSmokeService] yolov8s_fire_smoke.onnx loaded');
    } catch (err) {
      this._status = 'failed';
      console.warn('[FireSmokeService] Failed to load model:', err.message);
    }
  }

  get ready()  { return this._ready;  }
  get status() { return this._status; }

  /**
   * Detect fire and smoke in a JPEG frame.
   * @param {Buffer} jpegBuffer
   * @param {number} origW  Frame width in pixels
   * @param {number} origH  Frame height in pixels
   * @returns {Promise<Array<{className, confidence, bbox}>>}  Frame-coord bboxes
   */
  async detect(jpegBuffer, origW, origH) {
    if (!this._ready || !this._session) return [];
    try {
      const scale  = Math.min(MODEL_SIZE / origW, MODEL_SIZE / origH);
      const scaledW = Math.round(origW * scale);
      const scaledH = Math.round(origH * scale);
      const padL   = Math.floor((MODEL_SIZE - scaledW) / 2);
      const padT   = Math.floor((MODEL_SIZE - scaledH) / 2);

      const rawBuf = await sharp(jpegBuffer)
        .resize(scaledW, scaledH, { fit: 'fill' })
        .extend({
          top: padT, bottom: MODEL_SIZE - scaledH - padT,
          left: padL, right: MODEL_SIZE - scaledW - padL,
          background: { r: 114, g: 114, b: 114 },
        })
        .removeAlpha()
        .raw()
        .toBuffer();

      // HWC → CHW, normalize [0, 1]
      const numPx    = MODEL_SIZE * MODEL_SIZE;
      const float32  = new Float32Array(3 * numPx);
      for (let i = 0; i < numPx; i++) {
        float32[i]             = rawBuf[i * 3]     / 255;
        float32[numPx + i]     = rawBuf[i * 3 + 1] / 255;
        float32[2 * numPx + i] = rawBuf[i * 3 + 2] / 255;
      }

      const tensor = new ort.Tensor('float32', float32, [1, 3, MODEL_SIZE, MODEL_SIZE]);
      const feeds  = { [this._session.inputNames[0]]: tensor };
      const result = await this._session.run(feeds);
      const out    = result[this._session.outputNames[0]];

      return _postprocess(out.data, out.dims, origW, origH, scale, padL, padT);
    } catch (err) {
      console.error('[FireSmokeService] Detection error:', err.message);
      return [];
    }
  }
}

// ─── Post-processing ──────────────────────────────────────────────────────────

function _postprocess(data, dims, origW, origH, scale, padL, padT) {
  const numBoxes = dims[2];  // 8400
  const boxes = [];

  for (let i = 0; i < numBoxes; i++) {
    let maxScore = 0, classIdx = 0;
    for (let c = 0; c < CLASS_NAMES.length; c++) {
      const score = data[(4 + c) * numBoxes + i];
      if (score > maxScore) { maxScore = score; classIdx = c; }
    }
    if (maxScore < CONF_THRESHOLD) continue;

    const rawName = CLASS_NAMES[classIdx];
    if (SKIP_CLASSES.has(rawName)) continue;  // skip 'default' class

    const cx = data[0 * numBoxes + i];
    const cy = data[1 * numBoxes + i];
    const bw = data[2 * numBoxes + i];
    const bh = data[3 * numBoxes + i];

    const x1 = (cx - bw / 2 - padL) / scale;
    const y1 = (cy - bh / 2 - padT) / scale;
    const x2 = (cx + bw / 2 - padL) / scale;
    const y2 = (cy + bh / 2 - padT) / scale;

    boxes.push({
      className:  NORMALISE[rawName] || rawName,
      confidence: maxScore,
      bbox: {
        x:      Math.max(0, x1),
        y:      Math.max(0, y1),
        width:  Math.min(origW, x2) - Math.max(0, x1),
        height: Math.min(origH, y2) - Math.max(0, y1),
      },
    });
  }

  return _nms(boxes);
}

function _nms(boxes) {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  const suppressed = new Set();
  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j)) continue;
      if (_iou(boxes[i].bbox, boxes[j].bbox) > NMS_THRESHOLD) suppressed.add(j);
    }
  }
  return keep;
}

function _iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width,  b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!inter) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

module.exports = FireSmokeService;
