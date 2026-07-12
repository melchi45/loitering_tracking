'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const { dominantColor } = require('../utils/kmeansColor');

// AI-05 Phase-3 Human Parsing (Proposed) — per-track throttle interval.
// Not admin-configurable in v1 (YAGNI) — see Design_AI_Color_Analysis.md §10.6.
const HP_INTERVAL_MS = 4000;
const HP_MIN_MASK_PIXELS = 20;

// LIP-20 class order (SCHP) — see Design_AI_Color_Analysis.md §10.2.
const SCHP_LIP20_CLASS_MAP = { upper: [5, 6, 7], lower: [9, 10, 12] };
// Xenova/segformer_b2_clothes 18-class order — see Design_AI_Color_Analysis.md §10.2.
const SEGFORMER_CLOTHES_CLASS_MAP = { upper: [4, 7], lower: [5, 6] };

// PA100k's standard 26-attribute order, used verbatim as the CLIP text prompts when
// openpar_pa100k.onnx was exported (server/src/scripts/exportPromptPAR.py) — index
// position here must match that export exactly, since the model has no label metadata
// of its own (just a [1,26] logit vector). Grouping per the original PA100k paper:
// gender(1) / age(3) / view angle(3) / accessories(2) / bags(4) / upper style(6) /
// lower style(6, includes "long coat") / footwear(1).
const PA100K_ATTR_WORDS = [
  'female',
  'age over 60', 'age 18 to 60', 'age less 18',
  'front', 'side', 'back',
  'hat', 'glasses',
  'hand bag', 'shoulder bag', 'backpack', 'hold objects in front',
  'short sleeve', 'long sleeve', 'upper stride', 'upper logo', 'upper plaid', 'upper splice',
  'lower stripe', 'lower pattern', 'long coat', 'trousers', 'shorts', 'skirt and dress', 'boots',
];
// Resolved once from PA100K_ATTR_WORDS so _runPAR() reads by name, not magic index.
const PA100K_IDX = Object.fromEntries(PA100K_ATTR_WORDS.map((label, i) => [label, i]));

// PromptPAR memory gate — see Design_AI_Cloth_Analysis.md §Memory Gate.
// PromptPAR's CLIP ViT-L backbone (~1.2GB) is forced onto the CPU execution provider
// (see load()/reloadPar() below), which needs free RAM well beyond the raw checkpoint
// size for ONNX Runtime's session buffers/activations. Below this floor, loading it
// risks an OOM crash of the whole Node process instead of a contained failure — so we
// check first, and if there isn't enough headroom we log why and disable Cloth analysis
// instead of attempting the load. Override via PROMPTPAR_MIN_FREE_MEM_MB (server/.env).
const PROMPTPAR_MIN_FREE_MEM_MB = Number(process.env.PROMPTPAR_MIN_FREE_MEM_MB) || 2048;

// Only the CLIP ViT-L PromptPAR checkpoint is memory-gated. The lighter OpenPAR
// ResNet50 alternative (catalog id 'openpar-resnet50-pa100k', no CLIP/text-prompt
// fusion) has no equivalent DirectML/memory constraint and is never gated.
const PROMPTPAR_GATED_FILENAMES = new Set(['openpar_pa100k.onnx']);

function _isPromptParFile(filePath) {
  return PROMPTPAR_GATED_FILENAMES.has(path.basename(filePath));
}

/**
 * Check whether enough free system RAM currently exists to safely load PromptPAR.
 * @returns {{ok: boolean, freeMB: number, requiredMB: number}}
 */
function checkPromptParMemory() {
  const freeMB = Math.round(os.freemem() / (1024 * 1024));
  return { ok: freeMB >= PROMPTPAR_MIN_FREE_MEM_MB, freeMB, requiredMB: PROMPTPAR_MIN_FREE_MEM_MB };
}

/**
 * Color & Clothing attribute service.
 *
 * Phase-1 (immediate, no ML model):
 *   Dominant color extraction via pixel averaging on upper/lower body ROIs.
 *   Maps average RGB to a named color from an 11-color taxonomy.
 *
 * Phase-2 (PAR ONNX model, admin-selectable — see model catalog 'cloth-par' family):
 *   Pedestrian Attribute Recognition (PAR) for clothing type, sleeve length, etc.
 *   Two interchangeable models, both from https://github.com/Event-AHU/OpenPAR:
 *     - PromptPAR (PA100k, catalog id 'openpar-pa100k'): CLIP ViT-L backbone,
 *       higher accuracy, forced onto CPU (see load()/reloadPar()), memory-gated
 *       (PROMPTPAR_MIN_FREE_MEM_MB) — see Design_AI_Cloth_Analysis.md §Memory Gate.
 *     - OpenPAR (ResNet50, catalog id 'openpar-resnet50-pa100k'): lighter baseline
 *       classifier, no CLIP backbone, not memory-gated, manual export only.
 *   Admins pick one in Admin Dashboard → AI Models → Cloth Attribute (PAR) → Activate.
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
    // PAR ONNX model path (Phase-2, optional) — PromptPAR fine-tuned on PA100k,
    // see PA100K_ATTR_WORDS / _runPAR() below.
    this.parModelPath = options.parModelPath ||
      path.resolve(__dirname, '..', '..', 'models', 'openpar_pa100k.onnx');
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
      if (!this._checkPromptParGate(this.parModelPath)) {
        // Gated: _checkPromptParGate() already logged the reason and disabled
        // Cloth analysis. Skip loading — _parReady stays false.
      } else {
        try {
          const ort = require('onnxruntime-node');
          const { createOnnxSession } = require('../utils/onnxOptions');
          // forceCpu: PromptPAR's CLIP ViT-L backbone (~1.2GB) reliably triggers
          // DXGI_ERROR_DEVICE_REMOVED on the DirectML execution provider during
          // inference on this hardware (session creation succeeds, run() doesn't) —
          // confirmed by reproducing it live. CPU is slower but stable.
          this._parSession = await createOnnxSession(ort, this.parModelPath, 'ColorClothService/PAR', { forceCpu: true });
          this._parReady = true;
          console.log('[ColorClothService] PAR model loaded (Phase-2 cloth analysis active)');
        } catch (e) {
          console.warn('[ColorClothService] PAR model load failed:', e.message);
        }
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
    let session = await createOnnxSession(ort, filePath, 'ColorClothService/HumanParsing');

    // Warm-up run with a synthetic tensor — surfaces execution-provider/shape
    // incompatibilities (e.g. quantized ops unsupported on DirectML, see
    // Design_AI_Color_Analysis.md §10.5) while switching models instead of on
    // the first live camera frame, where a native-level provider fault can
    // crash the whole process past JS try/catch.
    try {
      await this._warmUpHumanParsing(session, inputSize);
    } catch (err) {
      console.warn(
        `[ColorClothService] Human Parsing warm-up failed on preferred provider (${err.message}); retrying on CPU provider.`
      );
      session.release?.();
      session = await ort.InferenceSession.create(filePath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      await this._warmUpHumanParsing(session, inputSize); // let this throw if still broken
      console.warn('[ColorClothService] Human Parsing running on CPU fallback provider.');
    }

    this._hpSession?.release?.();
    this._hpSession   = session;
    this._hpClassMap  = classMap;
    this._hpInputSize = inputSize;
    this.hpModelPath  = filePath;
    this._hpReady     = true;
    this._parseCache.clear(); // model switch invalidates cached mask-derived colors
  }

  /**
   * Run one synthetic inference to validate a Human Parsing session's output
   * shape before it is exposed to live traffic. Throws if the session errors
   * or returns unusable output dims.
   */
  async _warmUpHumanParsing(session, inputSize) {
    const ort = require('onnxruntime-node');
    const inputName  = session.inputNames[0];
    const outputName = session.outputNames[0];
    const zeros  = new Float32Array(3 * inputSize * inputSize);
    const tensor = new ort.Tensor('float32', zeros, [1, 3, inputSize, inputSize]);
    const res    = await session.run({ [inputName]: tensor });
    const dims   = res[outputName]?.dims;
    if (!Array.isArray(dims) || dims.length !== 4 || dims[1] < 1 || dims[2] < 1 || dims[3] < 1) {
      throw new Error(`unexpected output dims: ${JSON.stringify(dims)}`);
    }
    return dims;
  }

  get humanParsingStatus() { return this._hpReady ? 'loaded' : 'not_started'; }

  /**
   * Pre-flight memory gate for PromptPAR (see PROMPTPAR_MIN_FREE_MEM_MB above).
   * Models that aren't gated (e.g. the lighter OpenPAR ResNet50 alternative)
   * always pass. On failure, logs a "PromptPAR 수행 불가능" reason and turns
   * Cloth analysis off via analyticsConfig so the pipeline doesn't keep
   * expecting `cloth` output from a model that was never loaded.
   * @param {string} filePath
   * @returns {boolean} true if loading may proceed
   */
  _checkPromptParGate(filePath) {
    if (!_isPromptParFile(filePath)) return true;
    const mem = checkPromptParMemory();
    if (mem.ok) return true;
    console.warn(
      `[ColorClothService] PromptPAR 수행 불가능: 가용 메모리 부족 (free=${mem.freeMB}MB < required=${mem.requiredMB}MB) — Cloth 분석을 비활성화합니다.`
    );
    try {
      require('./analyticsConfig').setConfig({ cloth: false });
    } catch (e) {
      console.warn('[ColorClothService] Cloth 분석 비활성화 실패:', e.message);
    }
    return false;
  }

  /**
   * Activate/switch the active PAR (cloth-type) model (model catalog hot-swap).
   * Throws if this is the PromptPAR checkpoint and the memory gate fails —
   * see _checkPromptParGate().
   * @param {string} filePath ONNX model path
   */
  async reloadPar(filePath) {
    if (!this._checkPromptParGate(filePath)) {
      const mem = checkPromptParMemory();
      throw new Error(
        `PromptPAR 수행 불가능: 가용 메모리 부족 (free=${mem.freeMB}MB < required=${mem.requiredMB}MB) — Cloth 분석이 비활성화되었습니다.`
      );
    }
    const ort = require('onnxruntime-node');
    const { createOnnxSession } = require('../utils/onnxOptions');
    // forceCpu — see load() above for why (DirectML GPU device removal on this model).
    const session = await createOnnxSession(ort, filePath, 'ColorClothService/PAR', { forceCpu: true });
    this._parSession?.release?.();
    this._parSession  = session;
    this.parModelPath = filePath;
    this._parReady    = true;
  }

  /** Deactivate the active PAR (cloth-type) model (model catalog Deactivate button). */
  unloadPar() {
    this._parSession?.release?.();
    this._parSession = null;
    this._parReady   = false;
  }

  /** Deactivate the active Human Parsing model (model catalog Deactivate button). */
  unloadHumanParsing() {
    this._hpSession?.release?.();
    this._hpSession   = null;
    this._hpClassMap  = null;
    this._hpReady     = false;
    this._parseCache.clear();
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

      // PromptPAR (CLIP ViT-L backbone) expects 224×224 → NCHW [1,3,224,224],
      // matching PromptPAR/dataset/AttrDataset.py get_transform()'s valid_transform.
      const SIZE = 224;
      const raw = await sharp(jpegBuffer)
        .extract({ left, top, width: cw, height: ch })
        .resize(SIZE, SIZE, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();

      // Normalize with mean=[0.5,0.5,0.5] std=[0.5,0.5,0.5] (NOT ImageNet stats —
      // PromptPAR's own get_transform() uses this simpler 0.5/0.5 normalization).
      const floatData = new Float32Array(3 * SIZE * SIZE);
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const pi = (r * SIZE + c) * 3;
          for (let ch2 = 0; ch2 < 3; ch2++) {
            floatData[ch2 * SIZE * SIZE + r * SIZE + c] = (raw[pi + ch2] / 255 - 0.5) / 0.5;
          }
        }
      }

      const ort = require('onnxruntime-node');
      const tensor = new ort.Tensor('float32', floatData, [1, 3, SIZE, SIZE]);
      const res    = await this._parSession.run({ input: tensor });
      const logits = res.attrs.data; // Float32Array[26], raw BatchNorm logits (no sigmoid yet)

      const sigmoid = (v) => 1 / (1 + Math.exp(-v));
      const P = {};
      for (const label of PA100K_ATTR_WORDS) P[label] = sigmoid(logits[PA100K_IDX[label]]);

      const argmaxLabel = (labels) => labels.reduce((best, l) => (P[l] > P[best] ? l : best), labels[0]);

      const AGE_LABELS = { 'age over 60': 'over60', 'age 18 to 60': '18to60', 'age less 18': 'less18' };
      const VIEW_LABELS = { front: 'front', side: 'side', back: 'back' };
      // No direct PA100k equivalent of the old placeholder's upper-garment TYPE
      // (tshirt/shirt/jacket/...) — PA100k only has sleeve length + style flags for
      // upper body, so we don't fabricate an `upper` categorical field here.
      const LOWER_LABELS = { trousers: 'trousers', shorts: 'shorts', 'skirt and dress': 'skirtAndDress' };

      const THRESH = 0.5;

      return {
        // Best-effort backward compatibility with the old 12-attribute placeholder.
        sleeve: P['short sleeve'] >= P['long sleeve'] ? 'short' : 'long',
        lower:  LOWER_LABELS[argmaxLabel(Object.keys(LOWER_LABELS))],
        // Full PA100k attribute set.
        gender:             P['female'] >= THRESH ? 'female' : 'male',
        ageGroup:           AGE_LABELS[argmaxLabel(Object.keys(AGE_LABELS))],
        viewAngle:          VIEW_LABELS[argmaxLabel(Object.keys(VIEW_LABELS))],
        hat:                P['hat']  >= THRESH,
        glasses:            P['glasses']  >= THRESH,
        handBag:            P['hand bag']  >= THRESH,
        shoulderBag:        P['shoulder bag'] >= THRESH,
        backpack:           P['backpack'] >= THRESH,
        holdObjectsInFront: P['hold objects in front'] >= THRESH,
        upperStride:        P['upper stride'] >= THRESH,
        upperLogo:          P['upper logo'] >= THRESH,
        upperPlaid:         P['upper plaid'] >= THRESH,
        upperSplice:        P['upper splice'] >= THRESH,
        lowerStripe:        P['lower stripe'] >= THRESH,
        lowerPattern:       P['lower pattern'] >= THRESH,
        longCoat:           P['long coat'] >= THRESH,
        boots:              P['boots'] >= THRESH,
      };
    } catch (err) {
      console.warn('[ColorClothService] _runPAR error:', err.message);
      return null;
    }
  }
}

module.exports = {
  ColorClothService, rgbToColorName, SCHP_LIP20_CLASS_MAP, SEGFORMER_CLOTHES_CLASS_MAP, PA100K_ATTR_WORDS,
  checkPromptParMemory, PROMPTPAR_MIN_FREE_MEM_MB,
};
