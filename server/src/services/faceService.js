'use strict';

const ort  = require('onnxruntime-node');
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

// ─── Constants ───────────────────────────────────────────────────────────────
const SCRFD_SIZE   = 640;
const ARCFACE_SIZE = 112;
const STRIDES      = [8, 16, 32];
const NUM_ANCHORS  = 2; // anchors per spatial location

// InsightFace canonical 5-point reference for 112×112 aligned crop
const ARCFACE_REF = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Stage-1: Face detection using SCRFD (InsightFace).
 * Stage-2: Face embedding extraction using ArcFace.
 *
 * Model files (download via scripts/downloadModels.js):
 *   server/models/scrfd_2.5g.onnx         — 3.3 MB
 *   server/models/arcface_w600k_r50.onnx  — 166 MB
 *
 * Reference:
 *   SCRFD:   https://huggingface.co/JackCui/facefusion/blob/main/scrfd_2.5g.onnx
 *   ArcFace: https://huggingface.co/FoivosPar/Arc2Face
 *            https://huggingface.co/onnx-community/arcface-onnx
 */
class FaceService {
  constructor(options = {}) {
    const modelsDir = path.resolve(__dirname, '..', '..', 'models');
    this.scrfdPath    = options.scrfdPath    || path.join(modelsDir, 'scrfd_2.5g.onnx');
    this.arcfacePath  = options.arcfacePath  || path.join(modelsDir, 'arcface_w600k_r50.onnx');
    this.confThresh   = options.confThresh   ?? 0.5;
    this.nmsThresh    = options.nmsThresh    ?? 0.4;
    this._scrfd    = null;
    this._arcface  = null;
    this._ready    = false;
  }

  async load() {
    if (!fs.existsSync(this.scrfdPath)) {
      console.warn('[FaceService] scrfd_2.5g.onnx not found — run: node server/src/scripts/downloadModels.js');
      return;
    }
    try {
      this._scrfd = await ort.InferenceSession.create(this.scrfdPath, {
        executionProviders: ['cpu'], graphOptimizationLevel: 'all',
      });
      this._ready = true;
      console.log('[FaceService] SCRFD loaded:', path.basename(this.scrfdPath));
    } catch (e) {
      console.warn('[FaceService] SCRFD load failed:', e.message);
      return;
    }

    if (fs.existsSync(this.arcfacePath)) {
      try {
        this._arcface = await ort.InferenceSession.create(this.arcfacePath, {
          executionProviders: ['cpu'], graphOptimizationLevel: 'all',
        });
        console.log('[FaceService] ArcFace loaded:', path.basename(this.arcfacePath));
      } catch (e) {
        console.warn('[FaceService] ArcFace load failed:', e.message);
      }
    } else {
      console.warn('[FaceService] arcface_w600k_r50.onnx not found — recognition disabled');
    }
  }

  get ready() { return this._ready; }

  /**
   * Detect faces in a JPEG frame.
   * @param {Buffer} jpegBuffer
   * @param {number} origW  Frame width in pixels
   * @param {number} origH  Frame height in pixels
   * @returns {Promise<Array<{bbox, score, landmarks}>>}
   */
  async detectFaces(jpegBuffer, origW, origH) {
    if (!this._ready) return [];

    const scale  = Math.min(SCRFD_SIZE / origW, SCRFD_SIZE / origH);
    const scaledW = Math.round(origW * scale);
    const scaledH = Math.round(origH * scale);
    const padL    = Math.floor((SCRFD_SIZE - scaledW) / 2);
    const padT    = Math.floor((SCRFD_SIZE - scaledH) / 2);

    const rgb = await sharp(jpegBuffer)
      .resize(scaledW, scaledH)
      .extend({
        top: padT, bottom: SCRFD_SIZE - scaledH - padT,
        left: padL, right: SCRFD_SIZE - scaledW - padL,
        background: { r: 0, g: 0, b: 0 },
      })
      .removeAlpha().raw().toBuffer();

    const n   = SCRFD_SIZE * SCRFD_SIZE;
    const f32 = new Float32Array(3 * n);
    // SCRFD normalisation: (x - 127.5) / 128
    for (let i = 0; i < n; i++) {
      f32[i]           = (rgb[i * 3]     - 127.5) / 128.0;
      f32[i + n]       = (rgb[i * 3 + 1] - 127.5) / 128.0;
      f32[i + 2 * n]   = (rgb[i * 3 + 2] - 127.5) / 128.0;
    }

    const tensor = new ort.Tensor('float32', f32, [1, 3, SCRFD_SIZE, SCRFD_SIZE]);
    const feeds  = { [this._scrfd.inputNames[0]]: tensor };
    const outs   = await this._scrfd.run(feeds);

    return this._postprocess(outs, scaledW, scaledH, padL, padT, origW, origH);
  }

  /**
   * Extract ArcFace embedding for a face crop.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} faceBbox  In frame pixel coordinates
   * @returns {Promise<number[]|null>}  512-D L2-normalised embedding, or null
   */
  async getEmbedding(jpegBuffer, faceBbox) {
    if (!this._arcface) return null;
    try {
      const { x, y, width, height } = faceBbox;
      const safe = {
        left: Math.max(0, Math.round(x)),
        top:  Math.max(0, Math.round(y)),
        width:  Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
      const crop = await sharp(jpegBuffer)
        .extract(safe)
        .resize(ARCFACE_SIZE, ARCFACE_SIZE)
        .removeAlpha().raw().toBuffer();

      const n   = ARCFACE_SIZE * ARCFACE_SIZE;
      const f32 = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        f32[i]         = (crop[i * 3]     - 127.5) / 128.0;
        f32[i + n]     = (crop[i * 3 + 1] - 127.5) / 128.0;
        f32[i + 2 * n] = (crop[i * 3 + 2] - 127.5) / 128.0;
      }

      const tensor = new ort.Tensor('float32', f32, [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]);
      const feeds  = { [this._arcface.inputNames[0]]: tensor };
      const result = await this._arcface.run(feeds);
      const emb    = Array.from(result[this._arcface.outputNames[0]].data);

      // L2 normalise
      const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
      return emb.map(v => v / norm);
    } catch {
      return null;
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _postprocess(outs, scaledW, scaledH, padL, padT, origW, origH) {
    const outNames = Object.keys(outs);
    const faces    = [];
    const sx = origW / scaledW;
    const sy = origH / scaledH;

    // InsightFace SCRFD outputs per stride: score_8/16/32, bbox_8/16/32, kps_8/16/32
    for (const stride of STRIDES) {
      const scoreName = outNames.find(n => n.includes('score') && n.includes(String(stride)));
      const bboxName  = outNames.find(n => n.includes('bbox')  && n.includes(String(stride)));
      const kpsName   = outNames.find(n => n.includes('kps')   && n.includes(String(stride)));

      if (!scoreName || !bboxName) continue;

      const scores = outs[scoreName].data;
      const bboxes = outs[bboxName].data;
      const kps    = kpsName ? outs[kpsName].data : null;
      const fmH    = Math.ceil(SCRFD_SIZE / stride);
      const fmW    = Math.ceil(SCRFD_SIZE / stride);

      let idx = 0;
      for (let row = 0; row < fmH; row++) {
        for (let col = 0; col < fmW; col++) {
          for (let a = 0; a < NUM_ANCHORS; a++, idx++) {
            const score = scores[idx];
            if (score < this.confThresh) continue;

            const cx = (col + 0.5) * stride;
            const cy = (row + 0.5) * stride;
            // SCRFD bbox: (left, top, right, bottom) offsets × stride
            const x1 = Math.max(0, (cx - bboxes[idx * 4 + 0] * stride - padL) * sx);
            const y1 = Math.max(0, (cy - bboxes[idx * 4 + 1] * stride - padT) * sy);
            const x2 = Math.min(origW, (cx + bboxes[idx * 4 + 2] * stride - padL) * sx);
            const y2 = Math.min(origH, (cy + bboxes[idx * 4 + 3] * stride - padT) * sy);

            if (x2 <= x1 || y2 <= y1) continue;

            const landmarks = [];
            if (kps) {
              for (let p = 0; p < 5; p++) {
                landmarks.push([
                  (kps[idx * 10 + p * 2]     * stride - padL) * sx,
                  (kps[idx * 10 + p * 2 + 1] * stride - padT) * sy,
                ]);
              }
            }
            faces.push({ score, bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, landmarks });
          }
        }
      }
    }

    // Fallback for single-output converted models (all anchors concatenated)
    if (faces.length === 0 && outNames.length >= 2) {
      const scores = outs[outNames[0]].data;
      const bboxes = outs[outNames[1]].data;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] < this.confThresh) continue;
        const x1 = Math.max(0, (bboxes[i * 4 + 0] - padL) * sx);
        const y1 = Math.max(0, (bboxes[i * 4 + 1] - padT) * sy);
        const x2 = Math.min(origW, (bboxes[i * 4 + 2] - padL) * sx);
        const y2 = Math.min(origH, (bboxes[i * 4 + 3] - padT) * sy);
        if (x2 > x1 && y2 > y1)
          faces.push({ score: scores[i], bbox: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, landmarks: [] });
      }
    }

    return this._nms(faces);
  }

  _nms(faces) {
    faces.sort((a, b) => b.score - a.score);
    const kept = [], used = new Set();
    for (let i = 0; i < faces.length; i++) {
      if (used.has(i)) continue;
      kept.push(faces[i]);
      for (let j = i + 1; j < faces.length; j++) {
        if (!used.has(j) && this._iou(faces[i].bbox, faces[j].bbox) > this.nmsThresh)
          used.add(j);
      }
    }
    return kept;
  }

  _iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (!inter) return 0;
    return inter / (a.width * a.height + b.width * b.height - inter);
  }
}

module.exports = FaceService;
