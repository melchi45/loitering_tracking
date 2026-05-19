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
 *   35% — dwell ratio (dwellTime / dwellThreshold)
 *   30% — revisit count (saturates at 5; includes appearance-based cross-ID revisits)
 *   15% — low velocity (stationary = 1, fast = 0; normalised at 80 px/s)
 *   12% — pacing score (x-direction reversal rate)
 *    8% — circular motion score
 */
function _riskScore(dwellTime, threshold, revisitCount, velocityPxPerSec, circScore, pacingScore) {
  const dwellRatio   = Math.min(dwellTime / Math.max(threshold, 1), 2) / 2;
  const revisitRatio = Math.min(revisitCount / 5, 1);
  const lowVeloRatio = Math.max(0, 1 - velocityPxPerSec / 80);
  return Math.min(1,
    dwellRatio   * 0.35 +
    revisitRatio * 0.30 +
    lowVeloRatio * 0.15 +
    pacingScore  * 0.12 +
    circScore    * 0.08
  );
}

/** Cosine similarity of two L2-normalised ArcFace embeddings (dot product). */
function _cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Pacing score: ratio of x-direction reversals to total movement steps.
 * A person pacing back and forth generates many direction changes.
 * Returns 0–1 (saturates at 10 reversals ≈ 5 pacing cycles at 10 FPS).
 */
function _pacingScore(frames, minFrames = 10) {
  if (frames.length < minFrames) return 0;
  let reversals = 0;
  let prevSign  = 0;
  for (let i = 1; i < frames.length; i++) {
    const dx = frames[i].x - frames[i - 1].x;
    if (Math.abs(dx) < 2) continue;
    const sign = Math.sign(dx);
    if (prevSign !== 0 && sign !== prevSign) reversals++;
    prevSign = sign;
  }
  return Math.min(1, reversals / 10);
}

// Maps zone targetClass keys to detection className values
const TARGET_CLASS_MAP = {
  human:       ['person'],
  vehicle:     ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  // Accessories group alias (for zone targetClasses backward-compat)
  accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'],
  // Individual accessory keys (Phase-1: COCO yolov8n, zero extra cost)
  backpack:    ['backpack'],
  handbag:     ['handbag'],
  suitcase:    ['suitcase'],
  umbrella:    ['umbrella'],
  tie:         ['tie'],
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
 *   - revisitCount:  how many times this object re-entered the zone, including
 *                    cross-ID revisits detected via ArcFace embedding or clothing colour
 *   - velocity:      average speed (px/s) over last 10 frames
 *   - pacingScore:   0–1 x-direction reversal rate (back-and-forth movement)
 *   - circularScore: 0–1 indicating repetitive/loop movement pattern
 *   - riskScore:     composite 0–1 priority score
 *                    (dwell 35% + revisit 30% + velocity 15% + pacing 12% + circular 8%)
 *
 * Displacement check uses a 10-second sliding window so pacing persons who
 * return near their starting position also trigger the loitering condition.
 */
class BehaviorEngine extends EventEmitter {
  /** @param {import('./zoneManager')} zoneManager */
  constructor(zoneManager) {
    super();
    this._zoneManager = zoneManager;
    // objectId → { frames: [{x,y,timestamp}], enteredAt, zoneId, lastLoiteringEmit, reentryData }
    this._state = new Map();
    // Per-zone appearance gallery for cross-ID revisit detection.
    // zoneId → [{ objectId, embedding, upperColor, lowerColor, lastSeenAt }]
    this._zoneGallery = new Map();
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
            break;
          }
          // Class didn't match this zone — keep searching for a zone that targets this class
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
        // Brand-new tracker ID — check if the same person was previously seen in this zone
        // via ArcFace embedding similarity or clothing colour match.
        const prevObjectId = this._checkAndEnrollAppearance(matchedZone.id, objectId, obj, now);

        if (prevObjectId) {
          // Cross-ID re-association: same person, new tracker ID.
          // Transfer the previous state so dwell time, trajectory, and revisit count
          // are fully preserved — loitering detection continues seamlessly.
          const prevState = this._state.get(prevObjectId);
          if (prevState) {
            state = { ...prevState, leftAt: null };  // resume; clear leftAt so re-entry gate won't fire
            this._state.delete(prevObjectId);
            const dwellSoFar = ((now - prevState.enteredAt) / 1000).toFixed(1);
            console.log(`[BehaviorEngine] Cross-ID resume: ${String(prevObjectId).slice(0,8)} → ${String(objectId).slice(0,8)} (dwell=${dwellSoFar}s revisit=${prevState.revisitCount})`);
          }
        }

        if (!state) {
          // Genuinely new appearance (no prior state found)
          state = {
            frames:            [],
            enteredAt:         now,
            zoneId:            matchedZone.id,
            lastLoiteringEmit: 0,
            reentryData:       null,
            leftAt:            null,
            revisitCount:      prevObjectId ? 1 : 0,  // appearance matched but state expired → mark as revisit
          };
        }

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

      // Refresh appearance gallery entry (updates embedding and colour for later revisit matching).
      this._checkAndEnrollAppearance(matchedZone.id, objectId, obj, now);

      // Push position to circular buffer
      state.frames.push({ x: cx, y: cy, timestamp: now });
      if (state.frames.length > HISTORY_CAPACITY) {
        state.frames.shift();
      }

      // Calculate dwellTime in seconds
      const dwellTime = (now - state.enteredAt) / 1000;

      // Sliding-window displacement: max distance moved in the last 10 seconds.
      // Using a rolling window catches pacing persons who return near their start
      // but haven't moved far recently — the critical fix for pacing loiterers.
      const WIN_MS       = 10000;
      const recentFrames = state.frames.filter(f => f.timestamp > now - WIN_MS);
      const winFrames    = recentFrames.length > 1 ? recentFrames : state.frames;
      const winOrigin    = winFrames[0];
      let maxDisp = 0;
      for (const f of winFrames) {
        const d = _dist(f, winOrigin);
        if (d > maxDisp) maxDisp = d;
      }

      // Velocity, pacing, circular motion, and composite risk score
      const velocity     = _computeVelocity(state.frames);
      const circScore    = _circularScore(state.frames);
      const pacingScore  = _pacingScore(state.frames);
      const revisitCount = state.revisitCount || 0;

      const isLoitering =
        dwellTime >= effectiveThreshold &&
        maxDisp  <= matchedZone.minDisplacement;

      const risk = _riskScore(
        dwellTime, effectiveThreshold, revisitCount, velocity, circScore, pacingScore
      );

      // Throttle emissions: emit at most once per dwellThreshold seconds.
      // minRiskScore gates alert generation — badge still shown for all isLoitering objects.
      if (isLoitering) {
        const cooldown = effectiveThreshold * 1000;
        const minRisk  = matchedZone.minRiskScore ?? 0;
        if (risk >= minRisk && now - state.lastLoiteringEmit >= cooldown) {
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
        pacingScore,
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
    this._zoneGallery.clear();
  }

  /**
   * Check whether an appearance matching this object already exists in the zone gallery.
   * Matches via ArcFace cosine similarity (primary) or clothing colour (fallback).
   * Returns true when a match is found under a DIFFERENT objectId (cross-ID revisit).
   * Always upserts the current appearance into the gallery.
   *
   * @param {string} zoneId
   * @param {number} objectId  Current tracker ID
   * @param {object} obj       Detection (may carry obj.face.embedding and obj.color)
   * @param {number} now       Current timestamp (ms)
   * @returns {string|null}  Previous objectId if same person matched under a different tracker ID,
   *                         null if this is the first appearance or same ID as before.
   */
  _checkAndEnrollAppearance(zoneId, objectId, obj, now) {
    const EXPIRY_MS   = 120000; // 2-minute appearance memory per zone
    const FACE_THRESH = 0.45;   // cosine similarity threshold for same-person

    let gallery = this._zoneGallery.get(zoneId);
    if (!gallery) { gallery = []; this._zoneGallery.set(zoneId, gallery); }

    // Prune stale entries
    const active = gallery.filter(e => now - e.lastSeenAt < EXPIRY_MS);
    this._zoneGallery.set(zoneId, active);

    const embedding  = obj.face?.embedding ?? null;
    const upperColor = obj.color?.upper    ?? null;
    const lowerColor = obj.color?.lower    ?? null;

    let matchIdx     = -1;
    let prevObjectId = null;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.objectId === objectId) { matchIdx = i; break; }  // same tracker — refresh, no cross-ID
      // Skip entries enrolled THIS frame — prevents same-frame false cross-ID matches where
      // one person's newly-added gallery entry gets matched by another person in the same batch.
      if (e.lastSeenAt >= now) continue;
      if (embedding && e.embedding && _cosine(embedding, e.embedding) > FACE_THRESH) {
        matchIdx = i; prevObjectId = e.objectId; break;
      }
      if (!embedding && upperColor && lowerColor &&
          e.upperColor === upperColor && e.lowerColor === lowerColor) {
        matchIdx = i; prevObjectId = e.objectId; break;
      }
    }

    if (matchIdx >= 0) {
      active[matchIdx].objectId  = objectId;
      active[matchIdx].lastSeenAt = now;
      if (embedding) active[matchIdx].embedding = embedding;  // refresh embedding EMA
    } else {
      active.push({ objectId, embedding, upperColor, lowerColor, lastSeenAt: now });
    }

    return prevObjectId;  // null = no prior match; non-null = previous tracker ID for same person
  }
}

module.exports = BehaviorEngine;
