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

// 11-color taxonomy (RGB centroid matching)
const COLOR_TABLE = [
  { name: 'black',   r: [0,   60],  g: [0,   60],  b: [0,   60]  },
  { name: 'white',   r: [190, 255], g: [190, 255], b: [190, 255] },
  { name: 'gray',    r: [60,  190], g: [60,  190], b: [60,  190] },
  { name: 'red',     r: [140, 255], g: [0,   100], b: [0,   100] },
  { name: 'orange',  r: [180, 255], g: [80,  170], b: [0,   80]  },
  { name: 'yellow',  r: [180, 255], g: [170, 255], b: [0,   100] },
  { name: 'green',   r: [0,   120], g: [100, 255], b: [0,   120] },
  { name: 'cyan',    r: [0,   100], g: [150, 255], b: [150, 255] },
  { name: 'blue',    r: [0,   100], g: [0,   120], b: [130, 255] },
  { name: 'purple',  r: [80,  200], g: [0,   100], b: [100, 220] },
  { name: 'brown',   r: [80,  180], g: [40,  110], b: [0,   80]  },
];

function rgbToColorName(r, g, b) {
  // Find best matching color: smallest Euclidean distance to centroid
  let best = 'unknown', bestDist = Infinity;
  for (const c of COLOR_TABLE) {
    const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
    if (inRange(r, c.r) && inRange(g, c.g) && inRange(b, c.b)) {
      const cr = (c.r[0] + c.r[1]) / 2;
      const cg = (c.g[0] + c.g[1]) / 2;
      const cb = (c.b[0] + c.b[1]) / 2;
      const dist = Math.sqrt((r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2);
      if (dist < bestDist) { bestDist = dist; best = c.name; }
    }
  }
  if (best === 'unknown') {
    // fallback: nearest centroid by distance only
    for (const c of COLOR_TABLE) {
      const cr = (c.r[0] + c.r[1]) / 2;
      const cg = (c.g[0] + c.g[1]) / 2;
      const cb = (c.b[0] + c.b[1]) / 2;
      const dist = Math.sqrt((r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2);
      if (dist < bestDist) { bestDist = dist; best = c.name; }
    }
  }
  return best;
}

async function avgColor(jpegBuffer, roi) {
  try {
    const { x, y, w, h } = roi;
    const safe = {
      left:   Math.max(0, Math.round(x)),
      top:    Math.max(0, Math.round(y)),
      width:  Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
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
   * @returns {Promise<{color: {upper:string, lower:string}, cloth: {upper:string, lower:string}|null}>}
   */
  async analyze(jpegBuffer, personBbox) {
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
      avgColor(jpegBuffer, upperRoi),
      avgColor(jpegBuffer, lowerRoi),
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
