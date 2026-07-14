'use strict';

const ort   = require('onnxruntime-node');
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');
const { createOnnxSession } = require('../utils/onnxOptions');

// ViT Gender Classifier (rizvandwiki/gender-classification-2) label order.
const VIT_GENDER_CLASSES = ['female', 'male'];

const INSIGHTFACE_SIZE = 96;
const VIT_SIZE = 224;

/**
 * AI Gender Classification (Proposed) — see docs/design/Design_AI_Gender_Classification.md.
 *
 * Two admin-selectable models share this service, distinguished by the active
 * model's filename (set via reload()/the model catalog):
 *   - InsightFace GenderAge (genderage.onnx)         — 96×96, gender[0:2] channels
 *     (same ONNX file as Age Estimation's insightface-genderage entry — the age
 *     channel there, output[2], is ignored here; this service reads output[0:2]
 *     instead. Each service opens its own independent ONNX session on the file.)
 *   - ViT Gender Classifier (vit_gender_classifier.onnx) — 224×224, 2-class softmax
 *
 * NOTE: InsightFace's exact gender channel convention (class 0 = female, class 1 =
 * male, per the upstream insightface project's own genderage.py) has NOT been
 * verified end-to-end against the actual model output in this environment — verify
 * once the model file is in place, before relying on its output in production. See
 * Design_AI_Gender_Classification.md §11.
 */
class GenderClassificationService {
  constructor(options = {}) {
    this.modelPath = options.modelPath ||
      path.resolve(__dirname, '..', '..', 'models', 'genderage.onnx');
    this._session = null;
    this._ready   = false;
    this._status  = 'not_started'; // 'not_started' | 'missing' | 'loaded' | 'failed'
  }

  async load() {
    if (!fs.existsSync(this.modelPath)) {
      console.log('[GenderClassificationService]', path.basename(this.modelPath), 'not found — Gender Classification (Proposed) pending');
      this._status = 'missing';
      return;
    }
    try {
      this._session = await createOnnxSession(ort, this.modelPath, 'GenderClassificationService');
      this._ready  = true;
      this._status = 'loaded';
      console.log('[GenderClassificationService] Model loaded (Proposed — Gender Classification active):', path.basename(this.modelPath));
    } catch (e) {
      this._status = 'failed';
      console.warn('[GenderClassificationService] Model load failed:', e.message);
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
    return file.includes('vit_gender_classifier') ? 'vit' : 'insightface';
  }

  /**
   * Classify gender from a face or person crop.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} bbox In frame pixel coordinates
   * @param {{isFaceCrop?: boolean}} opts
   * @returns {Promise<{value:'male'|'female', confidence:number, source:'face'|'body', modelId:string}|null>}
   */
  async classifyGender(jpegBuffer, bbox, { isFaceCrop = false } = {}) {
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
        const softmax = _softmax(output);
        let best = 0;
        for (let i = 1; i < softmax.length; i++) if (softmax[i] > softmax[best]) best = i;
        const value = VIT_GENDER_CLASSES[best] || null;
        return { value, confidence: softmax[best], source, modelId: 'vit-gender-classifier' };
      }

      // InsightFace genderage: output[0:2] are gender class logits (argmax —
      // convention: 0=female, 1=male), output[2] is the age channel (ignored here,
      // see ageEstimationService.js).
      const genderLogits = [output[0] ?? 0, output[1] ?? 0];
      const softmax = _softmax(genderLogits);
      const best = softmax[1] > softmax[0] ? 1 : 0;
      const value = best === 0 ? 'female' : 'male';
      return { value, confidence: softmax[best], source, modelId: 'insightface-genderage-gender' };
    } catch (err) {
      console.warn('[GenderClassificationService] classifyGender error:', err.message);
      return null;
    }
  }
}

function _softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

module.exports = { GenderClassificationService, VIT_GENDER_CLASSES };
