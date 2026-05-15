'use strict';

const { EventEmitter } = require('events');

const HISTORY_CAPACITY = 300;  // ~30 seconds at 10 FPS
const FPS = 10;

// ── Trajectory helpers ────────────────────────────────────────────────────────

/** Euclidean distance between two {x, y} points */
function _dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Compute average speed (px/s) from the last N frames in position history.
 * Returns 0 when fewer than 2 frames are available.
 */
function _computeVelocity(frames, windowFrames = 10) {
  if (frames.length < 2) return 0;
  const slice = frames.slice(-Math.min(windowFrames, frames.length));
  let totalDist = 0;
  for (let i = 1; i < slice.length; i++) totalDist += _dist(slice[i - 1], slice[i]);
  const dtMs = slice[slice.length - 1].timestamp - slice[0].timestamp;
  return dtMs > 0 ? (totalDist / dtMs) * 1000 : 0;  // px/s
}

/**
 * Circular motion score: ratio of straight-line displacement to total path length.
 * Low ratio (< 0.3) with long path suggests repetitive / loop movement.
 * Returns 0–1 where 1 = perfectly circular, 0 = straight line.
 */
function _circularScore(frames, minFrames = 20) {
  if (frames.length < minFrames) return 0;
  let pathLen = 0;
  for (let i = 1; i < frames.length; i++) pathLen += _dist(frames[i - 1], frames[i]);
  if (pathLen < 10) return 0;
  const displacement = _dist(frames[0], frames[frames.length - 1]);
  return Math.max(0, 1 - displacement / pathLen);
}

/**
 * Composite risk score (0–1) for prioritising alerts.
 *
 * Weights:
 *   40% — dwell ratio (dwellTime / dwellThreshold)
 *   30% — revisit count (saturates at 5 revisits)
 *   20% — low velocity (stationary = 1, fast = 0; normalised at 80 px/s)
 *   10% — circular motion score
 */
function _riskScore(dwellTime, threshold, revisitCount, velocityPxPerSec, circScore) {
  const dwellRatio   = Math.min(dwellTime / Math.max(threshold, 1), 2) / 2; // 0–1
  const revisitRatio = Math.min(revisitCount / 5, 1);
  const lowVeloRatio = Math.max(0, 1 - velocityPxPerSec / 80);
  return Math.min(1,
    dwellRatio   * 0.40 +
    revisitRatio * 0.30 +
    lowVeloRatio * 0.20 +
    circScore    * 0.10
  );
}

// Maps zone targetClass keys to detection className values
const TARGET_CLASS_MAP = {
  human:       ['person'],
  vehicle:     ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  // Accessories: always detected by yolov8n.onnx (COCO classes 24-28)
  accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'],
  // Attribute-based: require additional ONNX models (see attributePipeline.js)
  face:        ['person'],  // triggers faceService face detection sub-pipeline
  mask:        ['person'],  // triggers protectiveEquipService mask classification
  hat:         ['person'],  // triggers protectiveEquipService helmet/hat classification
  helmet:      ['person'],  // alias for hat/hardhat
  color:       ['person'],  // triggers colorClothService upper/lower color analysis
  cloth:       ['person'],  // triggers colorClothService clothing type (PAR model)
  // Indoor / office objects — YOLOv8n COCO 80-class, always available
  chair:       ['chair'],
  couch:       ['couch'],
  diningtable: ['dining table'],   // COCO class name has a space
  furniture:   ['chair', 'couch', 'dining table', 'bed'],
  laptop:      ['laptop'],
  tv:          ['tv'],
  keyboard:    ['keyboard'],
  mouse:       ['mouse'],
  cellphone:   ['cell phone'],     // COCO class name has a space
  computer:    ['laptop', 'tv', 'keyboard', 'mouse', 'cell phone'],
  clock:       ['clock'],
  cup:         ['cup'],
  bottle:      ['bottle'],
  book:        ['book'],
};

function classMatchesZone(className, targetClasses) {
  if (!targetClasses || targetClasses.length === 0) return true;
  for (const tc of targetClasses) {
    const allowed = TARGET_CLASS_MAP[tc] || [tc];
    if (allowed.includes(className)) return true;
  }
  return false;
}

// TODO(heatmap): Accumulate per-zone dwell-time grid and expose via /api/cameras/:id/heatmap.
//   Each cell = cumulative dwell seconds over a configurable rolling window (1h/24h/7d).
//   Render as a canvas overlay in CameraView.
//   Reference: adaptive_loitering_detection_rfp.md §추가 권장 기능 Heatmap

// TODO(cross-camera-reid): When the same person leaves camera A and appears in camera B,
//   correlate using ArcFace 512-dim embeddings stored per track (faceService already
//   extracts them). Requires a shared embedding store (Redis or Qdrant) and a
//   cross-camera event bus. Out of scope for single-server Node.js deployment.
//   Reference: adaptive_loitering_detection_rfp.md §추가 권장 기능 Cross-Camera ReID

// TODO(human-segmentation): Replace full-frame bbox with person mask from a lightweight
//   segmentation model (e.g. YOLO-SAM or NanoSAM) to improve cloth/color analysis accuracy
//   under partial occlusion. Blocked by: real-time CPU inference budget (SAM ~500ms/frame).
//   Feasible only with NVIDIA GPU / TensorRT. Mark as Phase-3 work.
//   Reference: adaptive_loitering_detection_rfp.md §2 Human Segmentation

/**
 * Detects loitering behavior from tracked objects within defined zones.
 * Emits 'loitering' when a person exceeds dwellThreshold with low displacement.
 *
 * Per-track metrics added (Adaptive Multi-Feature Tracking):
 *   - revisitCount: how many times this object re-entered the zone within reentryWindow
 *   - velocity: average speed (px/s) over last 10 frames
 *   - circularScore: 0–1 indicating repetitive/loop movement pattern
 *   - riskScore: composite 0–1 priority score (dwell 40% + revisit 30% + velocity 20% + circular 10%)
 */
class BehaviorEngine extends EventEmitter {
  /** @param {import('./zoneManager')} zoneManager */
  constructor(zoneManager) {
    super();
    this._zoneManager = zoneManager;
    // objectId → { frames: [{x,y,timestamp}], enteredAt, zoneId, lastLoiteringEmit, reentryData }
    this._state = new Map();
  }

  /**
   * Process tracked objects for a given frame.
   * @param {string} cameraId
   * @param {Array<{objectId,bbox,confidence,state}>} trackedObjects
   * @param {number} frameTimestamp  Unix ms timestamp
   * @returns {Array}  Enriched objects with { ...tracked, isLoitering, dwellTime, zoneId }
   */
  update(cameraId, trackedObjects, frameTimestamp) {
    const now = frameTimestamp || Date.now();
    const zones = this._zoneManager.getActiveZones(cameraId, new Date(now));

    const enriched = [];

    for (const obj of trackedObjects) {
      const { objectId, bbox } = obj;
      const cx = bbox.x + bbox.width  / 2;
      const cy = bbox.y + bbox.height / 2;

      const objClass = obj.className || 'person';

      // Determine which MONITOR zone (if any) the object is in and class is targeted
      let matchedZone = null;
      for (const zone of zones) {
        if (zone.type === 'MONITOR' && this._zoneManager.isPointInZone(cx, cy, zone)) {
          if (classMatchesZone(objClass, zone.targetClasses)) {
            matchedZone = zone;
          }
          break;
        }
      }

      // Skip objects inside EXCLUDE zones
      const inExclude = zones.some(
        z => z.type === 'EXCLUDE' && this._zoneManager.isPointInZone(cx, cy, z)
      );
      if (inExclude) {
        this._clearState(objectId);
        enriched.push({ ...obj, isLoitering: false, dwellTime: 0, zoneId: null });
        continue;
      }

      if (!matchedZone) {
        // Left any zone — clear state (but preserve for re-entry window)
        const prev = this._state.get(objectId);
        if (prev) {
          prev.leftAt = now;
          // Keep state briefly for re-entry detection
        }
        enriched.push({ ...obj, isLoitering: false, dwellTime: 0, zoneId: null });
        continue;
      }

      // Object is inside a MONITOR zone
      let state = this._state.get(objectId);

      if (!state) {
        // Brand-new track entering zone
        state = {
          frames:            [],
          enteredAt:         now,
          zoneId:            matchedZone.id,
          lastLoiteringEmit: 0,
          reentryData:       null,
          leftAt:            null,
          revisitCount:      0,  // number of times this object re-entered the zone
        };
        this._state.set(objectId, state);
      } else if (state.zoneId !== matchedZone.id) {
        // Switched zones — reset position history, keep revisit count
        state.enteredAt = now;
        state.zoneId    = matchedZone.id;
        state.frames    = [];
      }

      // Handle re-entry: if this object re-enters within reentryWindow,
      // cut the effective threshold by 50% and increment revisit counter
      let effectiveThreshold = matchedZone.dwellThreshold;
      if (state.leftAt) {
        const gapSec = (now - state.leftAt) / 1000;
        if (gapSec <= matchedZone.reentryWindow) {
          effectiveThreshold = Math.max(1, Math.floor(effectiveThreshold * 0.5));
          state.revisitCount = (state.revisitCount || 0) + 1;
        }
        state.leftAt = null;
      }

      // Push position to circular buffer
      state.frames.push({ x: cx, y: cy, timestamp: now });
      if (state.frames.length > HISTORY_CAPACITY) {
        state.frames.shift();
      }

      // Calculate dwellTime in seconds
      const dwellTime = (now - state.enteredAt) / 1000;

      // Calculate max displacement from initial position
      const origin = state.frames[0];
      let maxDisp = 0;
      for (const f of state.frames) {
        const d = Math.sqrt((f.x - origin.x) ** 2 + (f.y - origin.y) ** 2);
        if (d > maxDisp) maxDisp = d;
      }

      // Velocity, circular motion, and risk score
      const velocity     = _computeVelocity(state.frames);
      const circScore    = _circularScore(state.frames);
      const revisitCount = state.revisitCount || 0;

      const isLoitering =
        dwellTime >= effectiveThreshold &&
        maxDisp  <= matchedZone.minDisplacement;

      const risk = _riskScore(
        dwellTime, effectiveThreshold, revisitCount, velocity, circScore
      );

      // TODO(suspicious-score): Surface riskScore in alert payload and
      //   allow per-zone minimum riskScore threshold (e.g. only alert if risk > 0.6).
      //   Reference: adaptive_loitering_detection_rfp.md §8 Suspicious Score

      // Throttle emissions: emit at most once per dwellThreshold seconds
      if (isLoitering) {
        const cooldown = effectiveThreshold * 1000;
        if (now - state.lastLoiteringEmit >= cooldown) {
          state.lastLoiteringEmit = now;
          this.emit('loitering', {
            cameraId,
            objectId,
            zoneId:          matchedZone.id,
            zoneName:        matchedZone.name,
            dwellTime,
            maxDisplacement: maxDisp,
            revisitCount,
            velocity,
            circularScore:   circScore,
            riskScore:       risk,
            bbox,
            timestamp:       now,
          });
        }
      }

      enriched.push({
        ...obj,
        isLoitering,
        dwellTime,
        zoneId:        matchedZone.id,
        revisitCount,
        velocity,
        circularScore: circScore,
        riskScore:     risk,
      });
    }

    // Purge state for objects no longer tracked
    const activeIds = new Set(trackedObjects.map(o => o.objectId));
    for (const [id, state] of this._state.entries()) {
      if (!activeIds.has(id) && state.leftAt === null) {
        state.leftAt = now;
      }
      // Remove state entries that have been gone longer than the max reentry window
      const maxWindow = 300000; // 5 minutes
      if (state.leftAt && now - state.leftAt > maxWindow) {
        this._state.delete(id);
      }
    }

    return enriched;
  }

  /** Remove tracking state for a specific object. */
  _clearState(objectId) {
    this._state.delete(objectId);
  }

  /** Reset all state (e.g. when camera stops). */
  reset() {
    this._state.clear();
  }
}

module.exports = BehaviorEngine;
