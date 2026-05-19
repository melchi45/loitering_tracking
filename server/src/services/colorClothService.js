'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

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
  }

  async load() {
    console.log('[ColorClothService] Phase-1 color extraction: ready (no model required)');

    if (fs.existsSync(this.parModelPath)) {
      try {
        const ort = require('onnxruntime-node');
        this._parSession = await ort.InferenceSession.create(this.parModelPath, {
          executionProviders: ['cpu'], graphOptimizationLevel: 'all',
        });
        this._parReady = true;
        console.log('[ColorClothService] PAR model loaded (Phase-2 cloth analysis active)');
      } catch (e) {
        console.warn('[ColorClothService] PAR model load failed:', e.message);
      }
    } else {
      console.log('[ColorClothService] openpar.onnx not found — cloth type analysis pending (Phase-2)');
      console.log('  Reference: https://github.com/Event-AHU/OpenPAR');
    }
  }

  get ready() { return this._colorReady; }

  /**
   * Extract color & clothing attributes from a person bounding box.
   * @param {Buffer} jpegBuffer
   * @param {{x,y,width,height}} personBbox
   * @param {number} [imgW]  Frame width in pixels (used to clamp ROI)
   * @param {number} [imgH]  Frame height in pixels (used to clamp ROI)
   * @returns {Promise<{color: {upper:string, lower:string}, cloth: {upper:string, lower:string}|null}>}
   */
  async analyze(jpegBuffer, personBbox, imgW, imgH) {
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

  async _runPAR(jpegBuffer, personBbox) {
    // Placeholder: implement OpenPAR inference when model is available
    // Input:  [1, 3, 256, 128] normalized person crop
    // Output: multi-label attributes [upper_type, lower_type, sleeve, collar, ...]
    return null;
  }
}

module.exports = { ColorClothService, rgbToColorName };
