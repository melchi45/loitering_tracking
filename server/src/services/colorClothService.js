'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');
const { dominantColor } = require('../utils/kmeansColor');

// AI-05 Phase-3 Human Parsing (Proposed) — per-track throttle interval.
// Not admin-configurable in v1 (YAGNI) — see Design_AI_Color_Analysis.md §10.6.
const HP_INTERVAL_MS = 4000;
const HP_MIN_MASK_PIXELS = 20;

// LIP-20 class order (SCHP) — see Design_AI_Color_Analysis.md §10.2.
const SCHP_LIP20_CLASS_MAP = { upper: [5, 6, 7], lower: [9, 10, 12] };
// Xenova/segformer_b2_clothes 18-class order — see Design_AI_Color_Analysis.md §10.2.
const SEGFORMER_CLOTHES_CLASS_MAP = { upper: [4, 7], lower: [5, 6] };

/**
 * Color & Clothing attribute service.
 *
 * Phase-1 (immediate, no ML model):
 *   Dominant color extraction via pixel averaging on upper/lower body ROIs.
 *   Maps average RGB to a named color from an 11-color taxonomy.
 *
 * Phase-2 (planned, requires PAR ONNX model):
 *   Pedestrian Attribute Recognition (PAR) for clothing type, sleeve length, etc.
 *   Reference model: https://github.com/Event-AHU/OpenPAR
 *   Export: torch.onnx.export(model, ...) → server/models/openpar.onnx
 *
 * AI-05 Color Analysis:  targetClass 'color'
 * AI-06 Cloth Analysis:  targetClass 'cloth'
 */

/**
 * Map an average RGB value to one of 11 color names using HSV color space.
 *
 * HSV-based classification is far more reliable than RGB range-matching because
 * the old range-based approach had gray defined as [60,190]×[60,190]×[60,190],
 * which swallowed all mid-tone colors (beige, tan, khaki, muted blue, etc.).
 *
 * Classification logic:
 *   1. Saturation < 15% → achromatic (black / white / gray by value)
 *   2. Otherwise → chromatic, classify by hue angle with a brown exception
 */
function rgbToColorName(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const v = max;
  const s = max === 0 ? 0 : delta / max;

  // Achromatic: low saturation → black / white / gray
  if (s < 0.15) {
    if (v < 0.25) return 'black';
    if (v > 0.80) return 'white';
    return 'gray';
  }

  // Chromatic: compute hue (0–360°)
  let h = 0;
  if (max === rn)      h = 60 * (((gn - bn) / delta) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
  else                 h = 60 * ((rn - gn) / delta + 4);
  if (h < 0) h += 360;

  // Brown: dark orange (low value, orange hue)
  if (h >= 10 && h < 50 && v < 0.55) return 'brown';

  if (h < 15 || h >= 345) return 'red';
  if (h <  50) return 'orange';
  if (h <  75) return 'yellow';
  if (h < 150) return 'green';
  if (h < 195) return 'cyan';
  if (h < 260) return 'blue';
  if (h < 320) return 'purple';
  return 'red';
}

async function avgColor(jpegBuffer, roi, imgW, imgH) {
  try {
    const { x, y, w, h } = roi;
    const left   = Math.max(0, Math.round(x));
    const top    = Math.max(0, Math.round(y));
    // Clamp right/bottom edges to image bounds (prevents sharp extract error → gray fallback)
    const right  = imgW ? Math.min(imgW, Math.round(x + w)) : Math.round(x + w);
    const bottom = imgH ? Math.min(imgH, Math.round(y + h)) : Math.round(y + h);
    const safe = {
      left,
      top,
      width:  Math.max(1, right  - left),
      height: Math.max(1, bottom - top),
    };
    // Resize to tiny patch for fast average
    const raw = await sharp(jpegBuffer)
      .extract(safe)
      .resize(8, 8, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();

    let sumR = 0, sumG = 0, sumB = 0;
    const n = raw.length / 3;
    for (let i = 0; i < n; i++) {
      sumR += raw[i * 3];
      sumG += raw[i * 3 + 1];
      sumB += raw[i * 3 + 2];
    }
    return [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)];
  } catch {
    return [128, 128, 128];
  }
}

class ColorClothService {
  constructor(options = {}) {
    // PAR ONNX model path (Phase-2, optional)
    this.parModelPath = options.parModelPath ||
      path.resolve(__dirname, '..', '..', 'models', 'openpar.onnx');
    this._parSession = null;
    this._parReady   = false;
    // Phase-1 color extraction is always available (no model needed)
    this._colorReady = true;

    // AI-05 Phase-3 Human Parsing (Proposed, not yet enabled by default).
    // Model catalog (server/src/routes/analysisApi.js) may call reloadHumanParsing()
    // to activate/switch a model at runtime; startup auto-loads schp_lip.onnx if present.
    this.hpModelPath = options.hpModelPath ||
      path.resolve(__dirname, '..', '..', 'models', 'schp_lip.onnx');
    this._hpSession   = null;
    this._hpReady     = false;
    this._hpClassMap  = null;  // { upper: number[], lower: number[] } for the active model
    this._hpInputSize = 473;
    this._parseCache  = new Map(); // objectId -> { ts, color }
  }

  async load() {
    console.log('[ColorClothService] Phase-1 color extraction: ready (no model required)');

    if (fs.existsSync(this.parModelPath)) {
      try {
        const ort = require('onnxruntime-node');
        const { createOnnxSession } = require('../utils/onnxOptions');
        this._parSession = await createOnnxSession(ort, this.parModelPath, 'ColorClothService/PAR');
        this._parReady = true;
        console.log('[ColorClothService] PAR model loaded (Phase-2 cloth analysis active)');
      } catch (e) {
        console.warn('[ColorClothService] PAR model load failed:', e.message);
      }
    } else {
      console.log('[ColorClothService] openpar.onnx not found — cloth type analysis pending (Phase-2)');
      console.log('  Reference: https://github.com/Event-AHU/OpenPAR');
    }

    if (fs.existsSync(this.hpModelPath)) {
      try {
        await this.reloadHumanParsing(this.hpModelPath, SCHP_LIP20_CLASS_MAP, 473);
        console.log('[ColorClothService] Human Parsing model loaded (Phase-3, Proposed — active): schp_lip.onnx');
      } catch (e) {
        console.warn('[ColorClothService] Human Parsing model load failed:', e.message);
      }
    } else {
      console.log('[ColorClothService] schp_lip.onnx not found — Human Parsing (Phase-3, Proposed) pending');
      console.log('  Run: npm run download-models (entry disabled by default — verify source, then enable)');
    }
  }

  /**
   * Activate/switch the active Human Parsing model (model catalog hot-swap).
   * @param {string} filePath ONNX model path
   * @param {{upper:number[], lower:number[]}} classMap Which output classes map to upper/lower clothing
   * @param {number} inputSize Native square input resolution (e.g. 473 for SCHP, 512 for SegFormer)
   */
  async reloadHumanParsing(filePath, classMap, inputSize) {
    const ort = require('onnxruntime-node');
    const { createOnnxSession } = require('../utils/onnxOptions');
    const session = await createOnnxSession(ort, filePath, 'ColorClothService/HumanParsing');
    this._hpSession   = session;
    this._hpClassMap  = classMap;
    this._hpInputSize = inputSize;
    this.hpModelPath  = filePath;
    this._hpReady     = true;
    this._parseCache.clear(); // model switch invalidates cached mask-derived colors
  }

  get humanParsingStatus() { return this._hpReady ? 'loaded' : 'not_started'; }

  /**
   * Activate/switch the active PAR (cloth-type) model (model catalog hot-swap).
   * @param {string} filePath ONNX model path
   */
  async reloadPar(filePath) {
    const ort = require('onnxruntime-node');
    const { createOnnxSession } = require('../utils/onnxOptions');
    this._parSession  = await createOnnxSession(ort, filePath, 'ColorClothService/PAR');
    this.parModelPath = filePath;
    this._parReady    = true;
  }

  /** Drop a per-track Human Parsing color cache entry (tracker lifecycle hook). */
  dropTrack(objectId) {
    this._parseCache.delete(String(objectId));
  }

  get ready() { return this._colorReady; }

  /**
   * Fast pixel-average colour extraction only — no model required (~0.5 ms/person).
   * Called by PipelineManager BEFORE tracker.update() so new detections carry
   * colour data into the multi-cue association step.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} personBbox
   * @param {number} [imgW]
   * @param {number} [imgH]
   * @returns {Promise<{upper:string,lower:string,upperRgb:number[],lowerRgb:number[]}>}
   */
  async fastColor(jpegBuffer, personBbox, imgW, imgH) {
    const { x, y, width, height } = personBbox;
    const upperRoi = { x: x + width * 0.15, y: y + height * 0.25, w: width * 0.70, h: height * 0.30 };
    const lowerRoi = { x: x + width * 0.15, y: y + height * 0.55, w: width * 0.70, h: height * 0.35 };
    const [upperRgb, lowerRgb] = await Promise.all([
      avgColor(jpegBuffer, upperRoi, imgW, imgH),
      avgColor(jpegBuffer, lowerRoi, imgW, imgH),
    ]);
    return {
      upper:    rgbToColorName(upperRgb[0], upperRgb[1], upperRgb[2]),
      lower:    rgbToColorName(lowerRgb[0], lowerRgb[1], lowerRgb[2]),
      upperRgb,
      lowerRgb,
    };
  }

  /**
   * Extract color & clothing attributes from a person bounding box.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} personBbox
   * @param {number} [imgW]  Frame width in pixels (used to clamp ROI)
   * @param {number} [imgH]  Frame height in pixels (used to clamp ROI)
   * @param {{objectId?: string|number, useHumanParsing?: boolean}} [opts] AI-05 Phase-3 (Proposed)
   * @returns {Promise<{color: {upper:string, lower:string}, cloth: {upper:string, lower:string}|null}>}
   */
  async analyze(jpegBuffer, personBbox, imgW, imgH, opts = {}) {
    if (opts.useHumanParsing && opts.objectId != null) {
      const hpColor = await this._runHumanParsing(jpegBuffer, personBbox, opts.objectId, imgW, imgH);
      if (hpColor) {
        const cloth = this._parReady ? await this._runPAR(jpegBuffer, personBbox) : null;
        return { color: hpColor, cloth };
      }
      // Model not ready / errored / cache miss with no session — fall through to Phase-1.
    }

    const { x, y, width, height } = personBbox;

    // Upper torso ROI: 25%–55% of bbox height, inner 70% width
    const upperRoi = {
      x: x + width  * 0.15,
      y: y + height * 0.25,
      w: width  * 0.70,
      h: height * 0.30,
    };
    // Lower torso ROI: 55%–90% of bbox height
    const lowerRoi = {
      x: x + width  * 0.15,
      y: y + height * 0.55,
      w: width  * 0.70,
      h: height * 0.35,
    };

    const [upperRgb, lowerRgb] = await Promise.all([
      avgColor(jpegBuffer, upperRoi, imgW, imgH),
      avgColor(jpegBuffer, lowerRoi, imgW, imgH),
    ]);

    const color = {
      upper: rgbToColorName(upperRgb[0], upperRgb[1], upperRgb[2]),
      lower: rgbToColorName(lowerRgb[0], lowerRgb[1], lowerRgb[2]),
      upperRgb,
      lowerRgb,
    };

    // Cloth type: Phase-2 PAR model (returns null if not loaded)
    const cloth = this._parReady ? await this._runPAR(jpegBuffer, personBbox) : null;

    return { color, cloth };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * AI-05 Phase-3 Human Parsing (Proposed) — mask-based dominant color extraction.
   * Per-track throttled: reuses a cached result within HP_INTERVAL_MS instead of
   * re-running the model every frame. See Design_AI_Color_Analysis.md §10.4.
   * @returns {Promise<null|{upper:string,lower:string,upperRgb:number[],lowerRgb:number[],source:'human-parsing'}>}
   */
  async _runHumanParsing(jpegBuffer, personBbox, objectId, imgW, imgH) {
    const key = String(objectId);
    const now = Date.now();
    const cached = this._parseCache.get(key);
    if (cached && (now - cached.ts) < HP_INTERVAL_MS) {
      return cached.color;
    }
    if (!this._hpReady) return null;

    try {
      const { x, y, width: w, height: h } = personBbox;
      const left = Math.max(0, Math.round(x));
      const top  = Math.max(0, Math.round(y));
      const cw   = Math.max(1, Math.round(w));
      const ch   = Math.max(1, Math.round(h));
      const size = this._hpInputSize;

      // Single crop+resize reused for BOTH the segmentation input tensor AND
      // the raw RGB buffer used for color sampling (avoids a second sharp pass).
      const raw = await sharp(jpegBuffer)
        .extract({ left, top, width: cw, height: ch })
        .resize(size, size, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer(); // size*size*3 bytes, RGB order

      const MEAN = [0.485, 0.456, 0.406];
      const STD  = [0.229, 0.224, 0.225];
      const floatData = new Float32Array(3 * size * size);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const pi = (r * size + c) * 3;
          for (let ch2 = 0; ch2 < 3; ch2++) {
            floatData[ch2 * size * size + r * size + c] =
              (raw[pi + ch2] / 255 - MEAN[ch2]) / STD[ch2];
          }
        }
      }

      const ort = require('onnxruntime-node');
      const inputName  = this._hpSession.inputNames[0];
      const outputName = this._hpSession.outputNames[0];
      const tensor = new ort.Tensor('float32', floatData, [1, 3, size, size]);
      const res    = await this._hpSession.run({ [inputName]: tensor });
      const logits = res[outputName]; // [1, numClasses, maskH, maskW]
      const [, numClasses, maskH, maskW] = logits.dims;
      const data  = logits.data;
      const plane = maskH * maskW;

      // Argmax per pixel over the class channel dimension.
      const mask = new Uint8Array(plane);
      for (let p = 0; p < plane; p++) {
        let bestC = 0, bestV = -Infinity;
        for (let c = 0; c < numClasses; c++) {
          const v = data[c * plane + p];
          if (v > bestV) { bestV = v; bestC = c; }
        }
        mask[p] = bestC;
      }

      // Sample colors at the mask's own resolution — resize the crop again only
      // if the model downsamples output relative to input (e.g. SegFormer ×4).
      let colorBuf = raw;
      if (maskW !== size || maskH !== size) {
        colorBuf = await sharp(jpegBuffer)
          .extract({ left, top, width: cw, height: ch })
          .resize(maskW, maskH, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer();
      }

      const upperSet = new Set(this._hpClassMap.upper);
      const lowerSet = new Set(this._hpClassMap.lower);
      const upperPixels = [];
      const lowerPixels = [];
      for (let p = 0; p < plane; p++) {
        const cls = mask[p];
        const pi  = p * 3;
        if (upperSet.has(cls)) upperPixels.push([colorBuf[pi], colorBuf[pi + 1], colorBuf[pi + 2]]);
        else if (lowerSet.has(cls)) lowerPixels.push([colorBuf[pi], colorBuf[pi + 1], colorBuf[pi + 2]]);
      }

      let upperRgb = upperPixels.length >= HP_MIN_MASK_PIXELS ? dominantColor(upperPixels) : null;
      let lowerRgb = lowerPixels.length >= HP_MIN_MASK_PIXELS ? dominantColor(lowerPixels) : null;

      // Fallback to the Phase-1 fixed-fraction average per region when the mask
      // yields too few pixels for that region (occlusion / crop truncation).
      if (!upperRgb || !lowerRgb) {
        const upperRoi = { x: x + w * 0.15, y: y + h * 0.25, w: w * 0.70, h: h * 0.30 };
        const lowerRoi = { x: x + w * 0.15, y: y + h * 0.55, w: w * 0.70, h: h * 0.35 };
        if (!upperRgb) upperRgb = await avgColor(jpegBuffer, upperRoi, imgW, imgH);
        if (!lowerRgb) lowerRgb = await avgColor(jpegBuffer, lowerRoi, imgW, imgH);
      }

      const color = {
        upper: rgbToColorName(upperRgb[0], upperRgb[1], upperRgb[2]),
        lower: rgbToColorName(lowerRgb[0], lowerRgb[1], lowerRgb[2]),
        upperRgb,
        lowerRgb,
        source: 'human-parsing',
      };
      this._parseCache.set(key, { ts: now, color });
      return color;
    } catch (err) {
      console.warn('[ColorClothService] _runHumanParsing error:', err.message);
      return null;
    }
  }

  async _runPAR(jpegBuffer, personBbox) {
    try {
      const { x, y, width: w, height: h } = personBbox;

      // Clamp crop to non-zero size
      const left   = Math.max(0, Math.round(x));
      const top    = Math.max(0, Math.round(y));
      const cw     = Math.max(1, Math.round(w));
      const ch     = Math.max(1, Math.round(h));

      // Resize person crop to 128×256 (W×H) → NCHW [1,3,256,128]
      const raw = await sharp(jpegBuffer)
        .extract({ left, top, width: cw, height: ch })
        .resize(128, 256, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();

      // Normalize with ImageNet mean/std → Float32 NCHW
      const MEAN = [0.485, 0.456, 0.406];
      const STD  = [0.229, 0.224, 0.225];
      const floatData = new Float32Array(3 * 256 * 128);
      for (let r = 0; r < 256; r++) {
        for (let c = 0; c < 128; c++) {
          const pi = (r * 128 + c) * 3;
          for (let ch2 = 0; ch2 < 3; ch2++) {
            floatData[ch2 * 256 * 128 + r * 128 + c] =
              (raw[pi + ch2] / 255 - MEAN[ch2]) / STD[ch2];
          }
        }
      }

      const ort = require('onnxruntime-node');
      const tensor = new ort.Tensor('float32', floatData, [1, 3, 256, 128]);
      const res    = await this._parSession.run({ input: tensor });
      const scores = res.attrs.data; // Float32Array[12]

      // Index map (matches exportPAR.py ATTR_LABELS)
      // Upper: 0=tshirt 1=shirt 2=jacket 3=hoodie 4=vest 5=dress
      // Lower: 6=pants  7=jeans 8=shorts 9=skirt
      // Sleeve: 10=short 11=long
      const THRESH = 0.45;

      const upperTypes = ['tshirt', 'shirt', 'jacket', 'hoodie', 'vest', 'dress'];
      let bestUpperIdx = 0;
      for (let i = 1; i < 6; i++) {
        if (scores[i] > scores[bestUpperIdx]) bestUpperIdx = i;
      }
      const upper = scores[bestUpperIdx] >= THRESH ? upperTypes[bestUpperIdx] : 'unknown';

      const lowerTypes = ['pants', 'jeans', 'shorts', 'skirt'];
      let bestLowerIdx = 0;
      for (let i = 1; i < 4; i++) {
        if (scores[6 + i] > scores[6 + bestLowerIdx]) bestLowerIdx = i;
      }
      const lower = scores[6 + bestLowerIdx] >= THRESH ? lowerTypes[bestLowerIdx] : 'unknown';

      const sleeve = scores[10] >= scores[11] ? 'short' : 'long';

      return { upper, lower, sleeve };
    } catch (err) {
      console.warn('[ColorClothService] _runPAR error:', err.message);
      return null;
    }
  }
}

module.exports = { ColorClothService, rgbToColorName, SCHP_LIP20_CLASS_MAP, SEGFORMER_CLOTHES_CLASS_MAP };
