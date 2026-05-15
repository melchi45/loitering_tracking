'use strict';

const ort   = require('onnxruntime-node');
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const INPUT_SIZE = 640;

/**
 * Protective equipment detection using a YOLOv8 model fine-tuned for PPE.
 *
 * Detects: hardhat, mask, no-hardhat, no-mask, safety vest, etc.
 * Used for AI-04 (Mask Detection) and AI-07 (Hat/Helmet Detection).
 *
 * Model file (export from Python — see scripts/downloadModels.js):
 *   server/models/yolov8m_ppe.onnx
 *
 * Source model:
 *   https://huggingface.co/keremberke/yolov8m-protective-equipment-detection
 *   Classes: Hardhat(0) Mask(1) NO-Hardhat(2) NO-Mask(3) NO-Safety-Vest(4)
 *            Person(5) Safety-Cone(6) Safety-Vest(7) machinery(8) vehicle(9)
 *
 * Export command (Python/ultralytics):
 *   from ultralytics import YOLO
 *   YOLO("best.pt").export(format="onnx", imgsz=640, simplify=True)
 */

const PPE_CLASSES = {
  0: 'hardhat',
  1: 'mask',
  2: 'no_hardhat',
  3: 'no_mask',
  4: 'no_safety_vest',
  5: 'ppe_person',
  6: 'safety_cone',
  7: 'safety_vest',
  8: 'machinery',
  9: 'ppe_vehicle',
};

const NUM_PPE_CLASSES = Object.keys(PPE_CLASSES).length;

class ProtectiveEquipService {
  constructor(options = {}) {
    this.modelPath  = options.modelPath  || path.resolve(__dirname, '..', '..', 'models', 'yolov8m_ppe.onnx');
    this.confThresh = options.confThresh ?? 0.4;
    this.nmsThresh  = options.nmsThresh  ?? 0.5;
    this._session   = null;
    this._ready     = false;
    this._numClasses = NUM_PPE_CLASSES;
  }

  async load() {
    if (!fs.existsSync(this.modelPath)) {
      console.warn('[PPEService] yolov8m_ppe.onnx not found — run: node server/src/scripts/downloadModels.js');
      return;
    }
    try {
      this._session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['cpu'], graphOptimizationLevel: 'all',
      });
      // Infer actual num classes from model output dims at first run
      this._ready = true;
      console.log('[PPEService] Protective equipment model loaded');
    } catch (e) {
      console.warn('[PPEService] Load failed:', e.message);
    }
  }

  get ready() { return this._ready; }

  /**
   * Detect PPE items in a JPEG frame.
   * @param {Buffer} jpegBuffer
   * @param {number} origW
   * @param {number} origH
   * @returns {Promise<Array<{bbox,confidence,classId,className}>>}
   */
  async detect(jpegBuffer, origW, origH) {
    if (!this._ready) return [];

    const scale   = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH);
    const scaledW = Math.round(origW * scale);
    const scaledH = Math.round(origH * scale);
    const padL    = Math.floor((INPUT_SIZE - scaledW) / 2);
    const padT    = Math.floor((INPUT_SIZE - scaledH) / 2);

    const rgb = await sharp(jpegBuffer)
      .resize(scaledW, scaledH)
      .extend({
        top: padT, bottom: INPUT_SIZE - scaledH - padT,
        left: padL, right: INPUT_SIZE - scaledW - padL,
        background: { r: 114, g: 114, b: 114 },
      })
      .removeAlpha().raw().toBuffer();

    const n   = INPUT_SIZE * INPUT_SIZE;
    const f32 = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      f32[i]         = rgb[i * 3]     / 255.0;
      f32[i + n]     = rgb[i * 3 + 1] / 255.0;
      f32[i + 2 * n] = rgb[i * 3 + 2] / 255.0;
    }

    const tensor = new ort.Tensor('float32', f32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const feeds  = { [this._session.inputNames[0]]: tensor };
    const result = await this._session.run(feeds);
    const out    = result[this._session.outputNames[0]];

    // Detect actual class count from output dims: [1, 4+NC, num_boxes]
    const actualNC = out.dims[1] - 4;
    if (actualNC !== this._numClasses && actualNC > 0) {
      this._numClasses = actualNC;
    }

    return this._postprocess(out.data, out.dims, scaledW, scaledH, padL, padT, origW, origH);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _postprocess(data, dims, scaledW, scaledH, padL, padT, origW, origH) {
    const numBoxes = dims[2];
    const NC       = this._numClasses;
    const sx       = origW / scaledW;
    const sy       = origH / scaledH;
    const cands    = [];

    for (let b = 0; b < numBoxes; b++) {
      const cx = data[0 * numBoxes + b];
      const cy = data[1 * numBoxes + b];
      const bw = data[2 * numBoxes + b];
      const bh = data[3 * numBoxes + b];

      let maxScore = 0, maxClass = -1;
      for (let c = 0; c < NC; c++) {
        const s = data[(4 + c) * numBoxes + b];
        if (s > maxScore) { maxScore = s; maxClass = c; }
      }

      if (maxScore < this.confThresh) continue;

      const x1 = Math.max(0,     (cx - bw / 2 - padL) * sx);
      const y1 = Math.max(0,     (cy - bh / 2 - padT) * sy);
      const x2 = Math.min(origW, (cx + bw / 2 - padL) * sx);
      const y2 = Math.min(origH, (cy + bh / 2 - padT) * sy);

      if (x2 <= x1 || y2 <= y1) continue;

      cands.push({
        bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
        confidence: maxScore,
        classId:  maxClass,
        className: PPE_CLASSES[maxClass] || `ppe_${maxClass}`,
      });
    }

    return this._nms(cands);
  }

  _nms(dets) {
    const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
    const kept = [], used = new Set();
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;
      kept.push(sorted[i]);
      for (let j = i + 1; j < sorted.length; j++) {
        if (!used.has(j) && this._iou(sorted[i].bbox, sorted[j].bbox) >= this.nmsThresh)
          used.add(j);
      }
    }
    return kept;
  }

  _iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width,  b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (!inter) return 0;
    return inter / (a.width * a.height + b.width * b.height - inter);
  }
}

module.exports = { ProtectiveEquipService, PPE_CLASSES };
