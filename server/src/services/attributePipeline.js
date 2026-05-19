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
    // Load each service independently — a failure in one must not block others
    await Promise.allSettled([
      this._face.load(),
      this._ppe.load(),
      this._color.load(),
    ]);
    this._loaded = true;
    console.log(
      `[AttributePipeline] ready — face:${this._face.ready} ppe:${this._ppe.ready} color:${this._color.ready}`
    );
  }

  get anyReady()   { return this._face.ready || this._ppe.ready || this._color.ready; }
  get ppeStatus()  { return this._ppe.status;   }
  get faceStatus() { return this._face.status;  }

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
  /**
   * Enrich tracked objects with face, PPE, and color attributes.
   * @returns {{ enrichedObjects: Array, detectedFaces: Array }}
   *   detectedFaces — raw SCRFD results for ALL faces in frame (frame coords),
   *   used by pipelineManager to emit face as a separate detection class.
   */
  async enrich(jpegBuffer, origW, origH, trackedObjects, zones, config = {}) {
    if (!this._loaded) return { enrichedObjects: trackedObjects, detectedFaces: [] };

    // Gate each service by BOTH model availability AND analytics config toggle
    const needFace  = this._face.ready  && (config.face  !== false);
    const needPPE   = this._ppe.ready   && (config.mask  !== false || config.hat !== false);
    const needColor = this._color.ready && (config.color !== false || config.cloth !== false);

    if (!needFace && !needPPE && !needColor) return { enrichedObjects: trackedObjects, detectedFaces: [] };

    // SCRFD runs on the full frame independently — does not require person detections.
    // This ensures face bboxes are emitted even when YOLOv8 misses the person bbox.
    let faces = needFace ? await this._face.detectFaces(jpegBuffer, origW, origH) : [];

    // ArcFace embedding extraction — runs in parallel for all detected faces
    if (needFace && faces.length > 0) {
      const embeddings = await Promise.all(
        faces.map(f => this._face.getEmbedding(jpegBuffer, f.bbox))
      );
      faces = faces.map((f, i) => ({ ...f, embedding: embeddings[i] }));
    }

    // PPE / color enrichment is person-crop based — skip when no persons.
    const persons = trackedObjects.filter(o => o.className === 'person');
    if (!persons.length) return { enrichedObjects: trackedObjects, detectedFaces: faces };

    const ppeItems = needPPE ? await this._ppe.detect(jpegBuffer, origW, origH) : [];

    // Color analysis is per-person (crop-based), run in parallel per person
    const colorMap = new Map();
    if (needColor) {
      await Promise.all(persons.map(async (p) => {
        const attrs = await this._color.analyze(jpegBuffer, p.bbox, origW, origH);
        colorMap.set(p.objectId, attrs);
      }));
    }

    const enrichedObjects = trackedObjects.map(obj => {
      if (obj.className !== 'person') return obj;

      const enriched = { ...obj };
      const headRoi  = _headRoi(obj.bbox);

      if (needFace) {
        // Use headRoi (top 35% of person bbox) for face matching — more accurate than
        // full-body bbox which gives IoU < 0.05 for a typical face-to-body size ratio
        const matched = _bestMatch(headRoi, faces.map(f => ({ bbox: f.bbox, score: f.score })));
        if (matched) enriched.face = { bbox: matched.bbox, score: matched.score };
      }

      if (needPPE) {
        if (config.mask !== false) {
          const maskDet = _bestMatch(
            headRoi,
            ppeItems.filter(p => p.className === 'mask' || p.className === 'no_mask')
          );
          // Always emit mask attribute when PPE model is running so the UI can
          // distinguish "model running, no result" (uncertain) from "model off".
          enriched.mask = maskDet ? {
            status:     maskDet.className === 'mask' ? 'mask_correct' : 'no_mask',
            confidence: maskDet.confidence,
          } : {
            status:     'uncertain',
            confidence: 0,
          };
        }
        if (config.hat !== false) {
          const hatDet = _bestMatch(
            headRoi,
            ppeItems.filter(p => p.className === 'hardhat' || p.className === 'no_hardhat')
          );
          // Always emit hat attribute when PPE model is running — null isHelmet = uncertain.
          if (hatDet) {
            const isHelmet = hatDet.className === 'hardhat';
            enriched.hat = {
              className:       hatDet.className,
              confidence:      hatDet.confidence,
              isHelmet,
              safetyCompliant: isHelmet ? true : false,
            };
          } else {
            enriched.hat = {
              className:       'uncertain',
              confidence:      0,
              isHelmet:        null,
              safetyCompliant: null,
            };
          }
        }
      }

      if (needColor && colorMap.has(obj.objectId)) {
        const { color, cloth } = colorMap.get(obj.objectId);
        if (config.color !== false) enriched.color = color;
        if (config.cloth !== false && cloth) enriched.cloth = cloth;
      }

      return enriched;
    });

    return { enrichedObjects, detectedFaces: faces };
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
