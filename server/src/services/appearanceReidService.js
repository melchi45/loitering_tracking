'use strict';

const ort   = require('onnxruntime-node');
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');
const { createOnnxSession } = require('../utils/onnxOptions');

// person-reidentification-retail-0287 (OSNet backbone, Intel Open Model Zoo).
// Input: data [1,3,256,128] float32 BGR NCHW · Output: reid_embedding [1,256].
const OSNET_H = 256;
const OSNET_W = 128;

/**
 * AI CrossCamera Face Tracking Phase-2 — Appearance/Body Re-ID embedding (Proposed).
 * See docs/design/Design_AI_AppearanceReID.md §12.
 *
 * Model file (not auto-downloaded — verify source before enabling, see
 * server/src/scripts/downloadModels.js): server/models/appearance_reid_osnet.onnx
 *
 * NOTE: preprocessing (mean/scale) below assumes raw BGR pixel values with no
 * normalization, per Intel Open Model Zoo's typical reid-retail model.yml
 * convention — this has NOT been verified end-to-end against the actual model
 * output in this environment (model download was not run here). Verify once
 * the model file is in place, before relying on match scores in production.
 */
class AppearanceReidService {
  constructor(options = {}) {
    this.modelPath = options.modelPath ||
      path.resolve(__dirname, '..', '..', 'models', 'appearance_reid_osnet.onnx');
    this._session = null;
    this._ready   = false;
    this._status  = 'not_started'; // 'not_started' | 'missing' | 'loaded' | 'failed'
  }

  async load() {
    if (!fs.existsSync(this.modelPath)) {
      console.log('[AppearanceReidService] appearance_reid_osnet.onnx not found — Appearance Re-ID (Proposed) pending');
      this._status = 'missing';
      return;
    }
    try {
      this._session = await createOnnxSession(ort, this.modelPath, 'AppearanceReidService/OSNet');
      this._ready  = true;
      this._status = 'loaded';
      console.log('[AppearanceReidService] OSNet model loaded (Proposed — Appearance Re-ID active):', path.basename(this.modelPath));
    } catch (e) {
      this._status = 'failed';
      console.warn('[AppearanceReidService] OSNet model load failed:', e.message);
    }
  }

  get ready()  { return this._ready;  }
  get status() { return this._status; }

  /** Activate/switch the active model (model catalog hot-swap). */
  async reload(filePath) {
    this.modelPath = filePath;
    this._ready = false;
    await this.load();
  }

  /**
   * Extract a 256-D L2-normalized appearance embedding for a person crop.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} personBbox In frame pixel coordinates
   * @returns {Promise<number[]|null>}
   */
  async getEmbedding(jpegBuffer, personBbox) {
    if (!this._ready) return null;
    try {
      const { x, y, width, height } = personBbox;
      const safe = {
        left:   Math.max(0, Math.round(x)),
        top:    Math.max(0, Math.round(y)),
        width:  Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
      const crop = await sharp(jpegBuffer)
        .extract(safe)
        .resize(OSNET_W, OSNET_H, { fit: 'fill' })
        .removeAlpha().raw().toBuffer(); // RGB order, OSNET_H*OSNET_W*3 bytes

      const n   = OSNET_H * OSNET_W;
      const f32 = new Float32Array(3 * n);
      // Model expects BGR — swap channel order 0<->2 relative to sharp's RGB output.
      for (let i = 0; i < n; i++) {
        f32[i]         = crop[i * 3 + 2]; // B
        f32[i + n]     = crop[i * 3 + 1]; // G
        f32[i + 2 * n] = crop[i * 3];     // R
      }

      const tensor = new ort.Tensor('float32', f32, [1, 3, OSNET_H, OSNET_W]);
      const feeds  = { [this._session.inputNames[0]]: tensor };
      const result = await this._session.run(feeds);
      const emb    = Array.from(result[this._session.outputNames[0]].data);

      const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
      return emb.map(v => v / norm);
    } catch (err) {
      console.warn('[AppearanceReidService] getEmbedding error:', err.message);
      return null;
    }
  }
}

/** Cosine similarity of two equal-length, already-normalized vectors. */
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

module.exports = { AppearanceReidService, cosineSim };
