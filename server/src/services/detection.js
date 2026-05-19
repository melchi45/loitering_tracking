'use strict';

const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');

const INPUT_SIZE = 640;

// Full COCO 80-class map — all 80 class IDs so that any class enabled via
// analyticsConfig (animals, food, sports equipment, home appliances, etc.)
// actually passes through the postprocess filter.
// Class-level gating is handled by analyticsConfig.isClassEnabled() in pipelineManager.
const ENABLED_CLASSES = {
  // People
  0:  'person',
  // Vehicles
  1:  'bicycle',
  2:  'car',
  3:  'motorcycle',
  4:  'airplane',
  5:  'bus',
  6:  'train',
  7:  'truck',
  8:  'boat',
  // Outdoor / Infrastructure
  9:  'traffic light',
  10: 'fire hydrant',
  11: 'stop sign',
  12: 'parking meter',
  13: 'bench',
  // Animals
  14: 'bird',
  15: 'cat',
  16: 'dog',
  17: 'horse',
  18: 'sheep',
  19: 'cow',
  20: 'elephant',
  21: 'bear',
  22: 'zebra',
  23: 'giraffe',
  // Accessories / carried items
  24: 'backpack',
  25: 'umbrella',
  26: 'handbag',
  27: 'tie',
  28: 'suitcase',
  // Sports & outdoor equipment
  29: 'frisbee',
  30: 'skis',
  31: 'snowboard',
  32: 'sports ball',
  33: 'kite',
  34: 'baseball bat',
  35: 'baseball glove',
  36: 'skateboard',
  37: 'surfboard',
  38: 'tennis racket',
  // Food / drink items
  39: 'bottle',
  40: 'wine glass',
  41: 'cup',
  42: 'fork',
  43: 'knife',
  44: 'spoon',
  45: 'bowl',
  46: 'banana',
  47: 'apple',
  48: 'sandwich',
  49: 'orange',
  50: 'broccoli',
  51: 'carrot',
  52: 'hot dog',
  53: 'pizza',
  54: 'donut',
  55: 'cake',
  // Indoor / furniture
  56: 'chair',
  57: 'couch',
  58: 'potted plant',
  59: 'bed',
  60: 'dining table',
  61: 'toilet',
  // Electronics / office
  62: 'tv',
  63: 'laptop',
  64: 'mouse',
  65: 'remote',
  66: 'keyboard',
  67: 'cell phone',
  // Kitchen appliances
  68: 'microwave',
  69: 'oven',
  70: 'toaster',
  71: 'sink',
  72: 'refrigerator',
  // Books / decorative
  73: 'book',
  74: 'clock',
  75: 'vase',
  // Personal items / tools
  76: 'scissors',
  77: 'teddy bear',
  78: 'hair drier',
  79: 'toothbrush',
};

/**
 * YOLOv8n ONNX inference service for person detection.
 */
class DetectionService {
  /**
   * @param {object} [options]
   * @param {string} [options.modelPath]          Path to yolov8n.onnx
   * @param {number} [options.confidenceThreshold=0.45]
   * @param {number} [options.iouThreshold=0.5]
   */
  constructor(options = {}) {
    this.modelPath = options.modelPath
      || path.resolve(__dirname, '..', '..', process.env.YOLO_MODEL || 'models/yolov8n.onnx');
    this.confidenceThreshold = options.confidenceThreshold
      || parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.30');
    this.iouThreshold = options.iouThreshold
      || parseFloat(process.env.NMS_IOU_THRESHOLD || '0.5');
    this._session     = null;
    this._loading     = null;
    this._numClasses  = null; // inferred from first inference output dims
  }

  /**
   * Load the ONNX model. Safe to call multiple times.
   * @returns {Promise<void>}
   */
  async load() {
    if (this._session) return;
    if (this._loading) return this._loading;
    this._loading = ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    }).then((session) => {
      this._session = session;
      this._loading = null;
    });
    return this._loading;
  }

  /**
   * Run detection on a JPEG frame buffer.
   * @param {Buffer} jpegBuffer  Raw JPEG bytes
   * @param {object} [originalSize]  { width, height } of original frame; defaults to INPUT_SIZE
   * @returns {Promise<Array<{bbox:{x,y,width,height}, confidence:number, classId:number, className:string}>>}
   */
  async detect(jpegBuffer, originalSize = null) {
    if (!this._session) await this.load();

    const { tensor, scaledW, scaledH, padLeft, padTop, srcW, srcH } =
      await this._preprocess(jpegBuffer);

    // Output bboxes in actual JPEG frame coordinates (e.g. 640×480), not model input space
    const origW = originalSize ? originalSize.width  : srcW;
    const origH = originalSize ? originalSize.height : srcH;

    const feeds = { [this._session.inputNames[0]]: tensor };
    const results = await this._session.run(feeds);
    const outputTensor = results[this._session.outputNames[0]];

    const detections = this._postprocess(
      outputTensor.data,
      outputTensor.dims,
      scaledW, scaledH, padLeft, padTop,
      origW, origH
    );

    return { detections, frameWidth: origW, frameHeight: origH };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Decode JPEG, letterbox-resize to 640×640, build CHW Float32Array tensor.
   */
  async _preprocess(jpegBuffer) {
    const meta = await sharp(jpegBuffer).metadata();
    const srcW = meta.width  || INPUT_SIZE;
    const srcH = meta.height || INPUT_SIZE;

    // Compute letterbox scale
    const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
    const scaledW = Math.round(srcW * scale);
    const scaledH = Math.round(srcH * scale);
    const padLeft = Math.floor((INPUT_SIZE - scaledW) / 2);
    const padTop  = Math.floor((INPUT_SIZE - scaledH) / 2);

    const rgbData = await sharp(jpegBuffer)
      .resize(scaledW, scaledH)
      .extend({
        top:    padTop,
        bottom: INPUT_SIZE - scaledH - padTop,
        left:   padLeft,
        right:  INPUT_SIZE - scaledW - padLeft,
        background: { r: 114, g: 114, b: 114 },
      })
      .removeAlpha()
      .raw()
      .toBuffer();

    const numPixels = INPUT_SIZE * INPUT_SIZE;
    const float32 = new Float32Array(3 * numPixels);

    for (let i = 0; i < numPixels; i++) {
      float32[i]                = rgbData[i * 3]     / 255.0; // R
      float32[i + numPixels]    = rgbData[i * 3 + 1] / 255.0; // G
      float32[i + 2 * numPixels]= rgbData[i * 3 + 2] / 255.0; // B
    }

    const tensor = new ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    return { tensor, scaledW, scaledH, padLeft, padTop, srcW, srcH };
  }

  /**
   * Parse YOLOv8 output [1, 84, 8400] and return enabled-class detections.
   * @param {Float32Array} data
   * @param {number[]}     dims      [1, 84, 8400]
   * @param {number} scaledW
   * @param {number} scaledH
   * @param {number} padLeft
   * @param {number} padTop
   * @param {number} origW
   * @param {number} origH
   * @returns {Array}
   */
  _postprocess(data, dims, scaledW, scaledH, padLeft, padTop, origW, origH) {
    const numBoxes  = dims[2];           // 8400 anchors
    const stride    = numBoxes;

    // Infer numClasses from output shape dims[1] = 4 (bbox) + numClasses
    const numClasses = dims[1] - 4;
    if (this._numClasses === null) {
      this._numClasses = numClasses;
      console.log(`[Detection] model output: [${dims.join(', ')}] — ${numClasses} classes, conf≥${this.confidenceThreshold}`);
      if (numClasses < 10) {
        console.warn(`[Detection] Only ${numClasses} class(es) detected — model may be a single-class fine-tune. Vehicles require a full COCO model.`);
      }
    }

    const candidates = [];

    for (let b = 0; b < numBoxes; b++) {
      const cx = data[0 * stride + b];
      const cy = data[1 * stride + b];
      const bw = data[2 * stride + b];
      const bh = data[3 * stride + b];

      // Class scores start at index 4
      let maxScore = 0;
      let maxClass = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * stride + b];
        if (score > maxScore) { maxScore = score; maxClass = c; }
      }

      if (!ENABLED_CLASSES[maxClass]) continue;
      if (maxScore < this.confidenceThreshold) continue;

      // Convert cx,cy,w,h (relative to INPUT_SIZE) to xyxy (relative to INPUT_SIZE)
      const x1 = cx - bw / 2;
      const y1 = cy - bh / 2;
      const x2 = cx + bw / 2;
      const y2 = cy + bh / 2;

      // Remove letterbox padding and scale back to original dimensions
      const scaleBackX = origW / scaledW;
      const scaleBackY = origH / scaledH;

      const ox1 = Math.max(0, (x1 - padLeft) * scaleBackX);
      const oy1 = Math.max(0, (y1 - padTop)  * scaleBackY);
      const ox2 = Math.min(origW, (x2 - padLeft) * scaleBackX);
      const oy2 = Math.min(origH, (y2 - padTop)  * scaleBackY);

      if (ox2 <= ox1 || oy2 <= oy1) continue;

      candidates.push({
        bbox: { x: ox1, y: oy1, width: ox2 - ox1, height: oy2 - oy1 },
        confidence: maxScore,
        classId: maxClass,
        className: ENABLED_CLASSES[maxClass],
      });
    }

    return this._nms(candidates);
  }

  /** Convert cx,cy,w,h → x1,y1,x2,y2 */
  _xywh2xyxy(cx, cy, w, h) {
    return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
  }

  /** Intersection-over-Union of two {bbox} objects */
  _iou(a, b) {
    const ax1 = a.bbox.x, ay1 = a.bbox.y;
    const ax2 = ax1 + a.bbox.width,  ay2 = ay1 + a.bbox.height;
    const bx1 = b.bbox.x, by1 = b.bbox.y;
    const bx2 = bx1 + b.bbox.width,  by2 = by1 + b.bbox.height;

    const interX1 = Math.max(ax1, bx1);
    const interY1 = Math.max(ay1, by1);
    const interX2 = Math.min(ax2, bx2);
    const interY2 = Math.min(ay2, by2);

    const interW = Math.max(0, interX2 - interX1);
    const interH = Math.max(0, interY2 - interY1);
    const interArea = interW * interH;
    if (interArea === 0) return 0;

    const aArea = a.bbox.width * a.bbox.height;
    const bArea = b.bbox.width * b.bbox.height;
    return interArea / (aArea + bArea - interArea);
  }

  /** Non-Maximum Suppression */
  _nms(detections) {
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
    const kept = [];
    const suppressed = new Set();

    for (let i = 0; i < sorted.length; i++) {
      if (suppressed.has(i)) continue;
      kept.push(sorted[i]);
      for (let j = i + 1; j < sorted.length; j++) {
        if (!suppressed.has(j) && this._iou(sorted[i], sorted[j]) >= this.iouThreshold) {
          suppressed.add(j);
        }
      }
    }
    return kept;
  }
}

module.exports = DetectionService;
