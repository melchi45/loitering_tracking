'use strict';

const FaceService                         = require('./faceService');
const { ProtectiveEquipService }          = require('./protectiveEquipService');
const { ColorClothService }               = require('./colorClothService');

// Zone targetClass keys that trigger each attribute service
const FACE_TRIGGERS   = new Set(['face']);
const PPE_TRIGGERS    = new Set(['mask', 'hat', 'helmet']);
const COLOR_TRIGGERS  = new Set(['color', 'cloth']);

/**
 * Orchestrates all attribute enrichment services for a video frame.
 *
 * After primary detection + tracking + behavior analysis, call:
 *   enrichedObjects = await pipeline.enrich(jpegBuf, w, h, trackedObjects, zones)
 *
 * Each service is loaded lazily and skipped gracefully when its model is absent.
 * Services are only invoked when a zone's targetClasses requires them.
 */
class AttributePipeline {
  constructor(options = {}) {
    this._face      = new FaceService(options.face);
    this._ppe       = new ProtectiveEquipService(options.ppe);
    this._color     = new ColorClothService(options.color);
    this._loaded    = false;
  }

  async load() {
    await Promise.all([
      this._face.load(),
      this._ppe.load(),
      this._color.load(),
    ]);
    this._loaded = true;
    console.log(
      `[AttributePipeline] ready — face:${this._face.ready} ppe:${this._ppe.ready} color:${this._color.ready}`
    );
  }

  get anyReady() {
    return this._face.ready || this._ppe.ready || this._color.ready;
  }

  /**
   * Enrich tracked detections with face, PPE, and color/cloth attributes.
   *
   * @param {Buffer}   jpegBuffer
   * @param {number}   origW           Frame width in pixels
   * @param {number}   origH           Frame height in pixels
   * @param {Array}    trackedObjects  Output from BehaviorEngine.update()
   * @param {Array}    zones           Active zone configs for this camera
   * @returns {Promise<Array>}         trackedObjects augmented with attribute fields
   */
  async enrich(jpegBuffer, origW, origH, trackedObjects, zones) {
    if (!this._loaded || !trackedObjects.length) return trackedObjects;

    // Run attribute analysis whenever the model is ready — zone targetClasses control
    // only loitering alerts (in behaviorEngine), not attribute enrichment.
    // Exception: if ANY zone explicitly opts out by listing only non-person classes
    // (e.g. ['vehicle']), still run face/PPE/color since other persons may be present.
    const needFace  = this._face.ready;
    const needPPE   = this._ppe.ready;
    const needColor = this._color.ready;

    if (!needFace && !needPPE && !needColor) return trackedObjects;

    const persons = trackedObjects.filter(o => o.className === 'person');
    if (!persons.length) return trackedObjects;

    // Run all required services in parallel on this frame
    const [faces, ppeItems] = await Promise.all([
      needFace ? this._face.detectFaces(jpegBuffer, origW, origH) : [],
      needPPE  ? this._ppe.detect(jpegBuffer, origW, origH)       : [],
    ]);

    // Color analysis is per-person (crop-based), run in parallel per person
    const colorMap = new Map();
    if (needColor) {
      await Promise.all(persons.map(async (p) => {
        const attrs = await this._color.analyze(jpegBuffer, p.bbox);
        colorMap.set(p.objectId, attrs);
      }));
    }

    return trackedObjects.map(obj => {
      if (obj.className !== 'person') return obj;

      const enriched = { ...obj };
      const headRoi  = _headRoi(obj.bbox);

      if (needFace) {
        const matched = _bestMatch(obj.bbox, faces.map(f => ({ bbox: f.bbox, score: f.score })));
        if (matched) enriched.face = { bbox: matched.bbox, score: matched.score };
      }

      if (needPPE) {
        const maskDet = _bestMatch(
          headRoi,
          ppeItems.filter(p => p.className === 'mask' || p.className === 'no_mask')
        );
        const hatDet = _bestMatch(
          headRoi,
          ppeItems.filter(p => p.className === 'hardhat' || p.className === 'no_hardhat')
        );
        if (maskDet) {
          enriched.mask = {
            status:     maskDet.className === 'mask' ? 'mask_correct' : 'no_mask',
            confidence: maskDet.confidence,
          };
        }
        if (hatDet) {
          enriched.hat = {
            className:  hatDet.className,
            confidence: hatDet.confidence,
            isHelmet:   hatDet.className === 'hardhat',
          };
        }
      }

      if (needColor && colorMap.has(obj.objectId)) {
        const { color, cloth } = colorMap.get(obj.objectId);
        enriched.color = color;
        if (cloth) enriched.cloth = cloth;
      }

      return enriched;
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _headRoi(bbox) {
  return {
    x:      bbox.x + bbox.width  * 0.15,
    y:      bbox.y,
    width:  bbox.width  * 0.70,
    height: bbox.height * 0.35,
  };
}

function _bestMatch(targetBbox, candidates, minIou = 0.1) {
  let best = null, bestIou = minIou;
  for (const c of candidates) {
    const iou = _iou(targetBbox, c.bbox);
    if (iou > bestIou) { bestIou = iou; best = c; }
  }
  return best;
}

function _iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width,  b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!inter) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

module.exports = AttributePipeline;
