'use strict';

const ort   = require('onnxruntime-node');
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');
const { createOnnxSession } = require('../utils/onnxOptions');

// ViT Age Classifier (nateraw/vit-age-classifier) 9-bucket taxonomy, in model output order.
const VIT_AGE_BUCKET_CLASSES = ['0-2', '3-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', 'more than 70'];

// Representative age (bucket midpoint) used to normalize the ViT classifier's bucket
// output onto the same numeric `value` scale as the InsightFace regression output.
const VIT_AGE_BUCKET_MIDPOINT = {
  '0-2': 1, '3-9': 6, '10-19': 14.5, '20-29': 24.5, '30-39': 34.5,
  '40-49': 44.5, '50-59': 54.5, '60-69': 64.5, 'more than 70': 75,
};

const INSIGHTFACE_SIZE = 96;
const VIT_SIZE = 224;

/**
 * AI Age Estimation (Proposed) — see docs/design/Design_AI_Age_Estimation.md.
 *
 * Two admin-selectable models share this service, distinguished by the active
 * model's filename (set via reload()/the model catalog):
 *   - InsightFace GenderAge (genderage.onnx)      — 96×96, regression age output
 *   - ViT Age Classifier (vit_age_classifier.onnx) — 224×224, 9-bucket softmax
 *
 * NOTE: InsightFace's exact output tensor layout (channel order, age scale factor)
 * has NOT been verified end-to-end against the actual model output in this
 * environment (model download was not run here) — verify once the model file is
 * in place, before relying on its numeric output in production. See
 * Design_AI_Age_Estimation.md §11.
 */
class AgeEstimationService {
  constructor(options = {}) {
    this.modelPath = options.modelPath ||
      path.resolve(__dirname, '..', '..', 'models', 'genderage.onnx');
    this._session = null;
    this._ready   = false;
    this._status  = 'not_started'; // 'not_started' | 'missing' | 'loaded' | 'failed'
  }

  async load() {
    if (!fs.existsSync(this.modelPath)) {
      console.log('[AgeEstimationService]', path.basename(this.modelPath), 'not found — Age Estimation (Proposed) pending');
      this._status = 'missing';
      return;
    }
    try {
      this._session = await createOnnxSession(ort, this.modelPath, 'AgeEstimationService');
      this._ready  = true;
      this._status = 'loaded';
      console.log('[AgeEstimationService] Model loaded (Proposed — Age Estimation active):', path.basename(this.modelPath));
    } catch (e) {
      this._status = 'failed';
      console.warn('[AgeEstimationService] Model load failed:', e.message);
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

  /** Deactivate the active model (model catalog Deactivate button). */
  unload() {
    this._session?.release?.();
    this._session = null;
    this._ready   = false;
    this._status  = 'not_started';
  }

  /** Which preprocessing/postprocessing variant applies to the currently active model. */
  _variant() {
    const file = path.basename(this.modelPath || '');
    return file.includes('vit_age_classifier') ? 'vit' : 'insightface';
  }

  /**
   * Estimate age from a face or person crop.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} bbox In frame pixel coordinates
   * @param {{isFaceCrop?: boolean}} opts
   * @returns {Promise<{value:number, bucket?:string, source:'face'|'body', modelId:string}|null>}
   */
  async estimateAge(jpegBuffer, bbox, { isFaceCrop = false } = {}) {
    if (!this._ready || !bbox) return null;
    const source = isFaceCrop ? 'face' : 'body';
    try {
      const variant = this._variant();
      const size = variant === 'vit' ? VIT_SIZE : INSIGHTFACE_SIZE;

      const { x, y, width, height } = bbox;
      const safe = {
        left:   Math.max(0, Math.round(x)),
        top:    Math.max(0, Math.round(y)),
        width:  Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
      const crop = await sharp(jpegBuffer)
        .extract(safe)
        .resize(size, size, { fit: 'fill' })
        .removeAlpha().raw().toBuffer(); // RGB order

      const n = size * size;
      const f32 = new Float32Array(3 * n);

      if (variant === 'vit') {
        // ImageNet normalization, RGB channel order, planar NCHW.
        const mean = [0.485, 0.456, 0.406];
        const std  = [0.229, 0.224, 0.225];
        for (let i = 0; i < n; i++) {
          f32[i]         = (crop[i * 3]     / 255 - mean[0]) / std[0]; // R
          f32[i + n]     = (crop[i * 3 + 1] / 255 - mean[1]) / std[1]; // G
          f32[i + 2 * n] = (crop[i * 3 + 2] / 255 - mean[2]) / std[2]; // B
        }
      } else {
        // InsightFace convention — BGR channel order, [-1, 1] normalization.
        for (let i = 0; i < n; i++) {
          f32[i]         = (crop[i * 3 + 2] - 127.5) / 127.5; // B
          f32[i + n]     = (crop[i * 3 + 1] - 127.5) / 127.5; // G
          f32[i + 2 * n] = (crop[i * 3]     - 127.5) / 127.5; // R
        }
      }

      const tensor = new ort.Tensor('float32', f32, [1, 3, size, size]);
      const feeds  = { [this._session.inputNames[0]]: tensor };
      const result = await this._session.run(feeds);
      const output = Array.from(result[this._session.outputNames[0]].data);

      if (variant === 'vit') {
        let best = 0;
        for (let i = 1; i < output.length; i++) if (output[i] > output[best]) best = i;
        const bucket = VIT_AGE_BUCKET_CLASSES[best] || null;
        return { value: bucket ? VIT_AGE_BUCKET_MIDPOINT[bucket] : null, bucket, source, modelId: 'vit-age-classifier' };
      }

      // InsightFace genderage: output[2] is the age channel, scaled ×100 by convention.
      const value = Math.round((output[2] ?? 0) * 100);
      return { value, source, modelId: 'insightface-genderage' };
    } catch (err) {
      console.warn('[AgeEstimationService] estimateAge error:', err.message);
      return null;
    }
  }
}

module.exports = { AgeEstimationService, VIT_AGE_BUCKET_CLASSES, VIT_AGE_BUCKET_MIDPOINT };
