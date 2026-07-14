'use strict';

const { v4: uuidv4 }      = require('uuid');
const trackerConfig        = require('./trackerConfig');

// ─── Kalman Filter ─────────────────────────────────────────────────────────
// State vector: [x, y, w, h, vx, vy, vw, vh]  (8 dimensions)
// Measurement:  [x, y, w, h]                  (4 dimensions)

class KalmanFilter {
  constructor() {
    // State vector (8×1)
    this.x = new Float64Array(8);

    // State covariance (8×8) — stored row-major as flat array
    this.P = KalmanFilter._eye(8, 10);

    // Transition matrix F (8×8)
    // x(t+1) = x(t) + vx(t), etc.
    this.F = KalmanFilter._eye(8, 1);
    this.F[0 * 8 + 4] = 1; // x += vx
    this.F[1 * 8 + 5] = 1; // y += vy
    this.F[2 * 8 + 6] = 1; // w += vw
    this.F[3 * 8 + 7] = 1; // h += vh

    // Observation matrix H (4×8): observe [x,y,w,h]
    this.H = new Float64Array(4 * 8);
    this.H[0 * 8 + 0] = 1;
    this.H[1 * 8 + 1] = 1;
    this.H[2 * 8 + 2] = 1;
    this.H[3 * 8 + 3] = 1;

    // Process noise Q (8×8)
    this.Q = KalmanFilter._eye(8, 1);

    // Measurement noise R (4×4)
    this.R = KalmanFilter._eye(4, 10);
  }

  /** Initialize state from first measurement [x,y,w,h] */
  init(bbox) {
    this.x[0] = bbox.x; this.x[1] = bbox.y;
    this.x[2] = bbox.width; this.x[3] = bbox.height;
    this.x[4] = 0; this.x[5] = 0; this.x[6] = 0; this.x[7] = 0;
  }

  /** Predict next state */
  predict() {
    // x = F * x
    this.x = KalmanFilter._matVec(this.F, this.x, 8, 8);
    // P = F * P * F^T + Q
    this.P = KalmanFilter._matAdd(
      KalmanFilter._matMul(
        KalmanFilter._matMul(this.F, this.P, 8, 8, 8),
        KalmanFilter._transpose(this.F, 8, 8), 8, 8, 8
      ),
      this.Q, 8, 8
    );
    return this._stateToBbox();
  }

  /** Update with measurement [x,y,w,h] */
  update(bbox) {
    const z = new Float64Array([bbox.x, bbox.y, bbox.width, bbox.height]);
    // Innovation: y = z - H*x
    const Hx = KalmanFilter._matVec(this.H, this.x, 4, 8);
    const y  = new Float64Array(4);
    for (let i = 0; i < 4; i++) y[i] = z[i] - Hx[i];

    // S = H * P * H^T + R  (4×4)
    const Ht = KalmanFilter._transpose(this.H, 4, 8);
    const S  = KalmanFilter._matAdd(
      KalmanFilter._matMul(
        KalmanFilter._matMul(this.H, this.P, 4, 8, 8),
        Ht, 4, 8, 4
      ),
      this.R, 4, 4
    );

    // K = P * H^T * S^-1  (8×4)
    const K = KalmanFilter._matMul(
      KalmanFilter._matMul(this.P, Ht, 8, 8, 4),
      KalmanFilter._inv4(S), 4, 4, 4
    );

    // x = x + K * y
    const Ky = KalmanFilter._matVec(K, y, 8, 4);
    for (let i = 0; i < 8; i++) this.x[i] += Ky[i];

    // P = (I - K*H) * P
    const KH = KalmanFilter._matMul(K, this.H, 8, 4, 8);
    const I  = KalmanFilter._eye(8, 1);
    const IKH = KalmanFilter._matSub(I, KH, 8, 8);
    this.P = KalmanFilter._matMul(IKH, this.P, 8, 8, 8);

    return this._stateToBbox();
  }

  _stateToBbox() {
    return { x: this.x[0], y: this.x[1], width: this.x[2], height: this.x[3] };
  }

  // ─── Matrix helpers ──────────────────────────────────────────────────────

  static _eye(n, scale = 1) {
    const m = new Float64Array(n * n);
    for (let i = 0; i < n; i++) m[i * n + i] = scale;
    return m;
  }

  static _matMul(A, B, rowsA, colsA, colsB) {
    const C = new Float64Array(rowsA * colsB);
    for (let i = 0; i < rowsA; i++)
      for (let k = 0; k < colsA; k++)
        if (A[i * colsA + k] !== 0)
          for (let j = 0; j < colsB; j++)
            C[i * colsB + j] += A[i * colsA + k] * B[k * colsB + j];
    return C;
  }

  static _matVec(A, v, rows, cols) {
    const r = new Float64Array(rows);
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++)
        r[i] += A[i * cols + j] * v[j];
    return r;
  }

  static _transpose(A, rows, cols) {
    const T = new Float64Array(cols * rows);
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++)
        T[j * rows + i] = A[i * cols + j];
    return T;
  }

  static _matAdd(A, B, rows, cols) {
    const C = new Float64Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) C[i] = A[i] + B[i];
    return C;
  }

  static _matSub(A, B, rows, cols) {
    const C = new Float64Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) C[i] = A[i] - B[i];
    return C;
  }

  /** Invert a 4×4 matrix via Gauss-Jordan elimination */
  static _inv4(M) {
    const A = new Float64Array(M);  // copy
    const I = KalmanFilter._eye(4, 1);
    const n = 4;
    for (let col = 0; col < n; col++) {
      // Partial pivot
      let maxRow = col;
      for (let row = col + 1; row < n; row++)
        if (Math.abs(A[row * n + col]) > Math.abs(A[maxRow * n + col])) maxRow = row;
      // Swap rows
      for (let k = 0; k < n; k++) {
        [A[col * n + k], A[maxRow * n + k]] = [A[maxRow * n + k], A[col * n + k]];
        [I[col * n + k], I[maxRow * n + k]] = [I[maxRow * n + k], I[col * n + k]];
      }
      const pivot = A[col * n + col];
      if (Math.abs(pivot) < 1e-12) return KalmanFilter._eye(4, 1);
      for (let k = 0; k < n; k++) {
        A[col * n + k] /= pivot;
        I[col * n + k] /= pivot;
      }
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = A[row * n + col];
        for (let k = 0; k < n; k++) {
          A[row * n + k] -= factor * A[col * n + k];
          I[row * n + k] -= factor * I[col * n + k];
        }
      }
    }
    return I;
  }
}

// ─── Track ──────────────────────────────────────────────────────────────────

const TrackState = Object.freeze({ Tracked: 'Tracked', Lost: 'Lost', Removed: 'Removed' });

class Track {
  constructor(detection) {
    this.id = uuidv4();
    this.state = TrackState.Tracked;
    this.age = 1;
    this.hitStreak = 1;
    this.framesWithoutHit = 0;
    this.bbox = { ...detection.bbox };
    this.confidence = detection.confidence;
    this.className = detection.className || 'person';
    this.firstSeenAt = Date.now();
    this.kf = new KalmanFilter();
    this.kf.init(detection.bbox);

    // Multi-cue appearance — all fields updated via ByteTracker.update*() after enrichment.
    // null until the first enrichment pass; each absent feature falls back gracefully.
    this.embedding    = null; // Float32Array(512) ArcFace embedding, or null
    this.embeddingAge = 0;    // frames since last updateAppearance()
    this.color        = null; // { upper, lower, upperRgb, lowerRgb } from fast pixel avg
    this.cloth        = null; // { upper, lower, sleeve } from PAR model, or null
    this.accessories  = null; // { hat: bool, mask: bool } from PPE model, or null
    this.estimatedAge = null; // { value, bucket?, source, modelId } from Age Estimation model (Proposed), or null
    this.estimatedGender = null; // { value, confidence, source, modelId } from Gender Classification model (Proposed), or null
  }

  predict() {
    this.age++;
    this.framesWithoutHit++;
    if (this.framesWithoutHit > 0) this.state = TrackState.Lost;
    if (this.embeddingAge < 255) this.embeddingAge++;

    if (this.framesWithoutHit <= 1) {
      // Track was just seen last frame — run the full adaptive Kalman prediction.
      const cfg = trackerConfig.getConfig();
      const vx = this.kf.x[4], vy = this.kf.x[5];
      const speed = Math.sqrt(vx * vx + vy * vy);
      let qScale = 1.0;
      if (speed > cfg.fastSpeedThreshold)      qScale = cfg.fastQScale;
      else if (speed < cfg.slowSpeedThreshold) qScale = cfg.slowQScale;
      this.kf.Q = KalmanFilter._eye(8, qScale);

      const prevBbox = { ...this.bbox };
      const predicted = this.kf.predict();
      const safeVal = (v, fallback) => isFinite(v) ? v : fallback;
      const px = safeVal(predicted.x,      prevBbox.x);
      const py = safeVal(predicted.y,      prevBbox.y);
      const pw = safeVal(predicted.width,  prevBbox.width);
      const ph = safeVal(predicted.height, prevBbox.height);

      // Sanity-check: if KF predicted position drifted more than 2× the bbox diagonal
      // from the last known position, the velocity estimate is unreliable — fall back to
      // frozen bbox so IoU matching isn't penalised by a wrong velocity extrapolation.
      const diagonal  = Math.sqrt(prevBbox.width ** 2 + prevBbox.height ** 2);
      const drift     = Math.sqrt((px - prevBbox.x) ** 2 + (py - prevBbox.y) ** 2);
      if (drift > diagonal * 2) {
        this.kf.init(prevBbox);  // reset KF to last-known position, clear bad velocity
      } else {
        this.bbox = {
          x:      Math.max(0, px),
          y:      Math.max(0, py),
          width:  Math.max(1, pw),
          height: Math.max(1, ph),
        };
      }
    }
    // For framesWithoutHit > 1 (extended Lost): freeze bbox at last known position.
    // Calling kf.predict() repeatedly on a Lost track causes the covariance matrix P
    // to grow unboundedly → numerical overflow → NaN bbox → IoU=NaN → track never
    // re-matches and a new ID is created every frame. Freezing prevents this.
  }

  update(detection) {
    // Sync R with current config so measurement noise is always up-to-date.
    this.kf.R = KalmanFilter._eye(4, trackerConfig.getConfig().measurementNoise);
    const corrected = this.kf.update(detection.bbox);
    // If KF update produces non-finite values (numerical blowup), fall back to
    // the raw detection bbox and reset P to keep the filter stable going forward.
    const safeVal = (v, fallback) => isFinite(v) ? v : fallback;
    const cx = safeVal(corrected.x,      detection.bbox.x);
    const cy = safeVal(corrected.y,      detection.bbox.y);
    const cw = safeVal(corrected.width,  detection.bbox.width);
    const ch = safeVal(corrected.height, detection.bbox.height);
    if (cx !== corrected.x || cy !== corrected.y) {
      // KF produced NaN/Inf — reset filter to prevent further corruption
      this.kf.init(detection.bbox);
      this.kf.P = KalmanFilter._eye(8, 10);
    }
    this.bbox = {
      x:      Math.max(0, cx),
      y:      Math.max(0, cy),
      width:  Math.max(1, cw),
      height: Math.max(1, ch),
    };
    this.confidence = detection.confidence;
    this.className = detection.className || this.className;
    this.hitStreak++;
    this.framesWithoutHit = 0;
    this.state = TrackState.Tracked;
  }

  toResult() {
    return {
      objectId:    this.id,
      bbox:        { ...this.bbox },
      confidence:  this.confidence,
      state:       this.state,
      className:   this.className,
      firstSeenAt: this.firstSeenAt,
    };
  }
}

// ─── ByteTracker ─────────────────────────────────────────────────────────────

/**
 * Simplified ByteTrack multi-object tracker.
 * Maintains persistent objectIds across frames.
 */
class ByteTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAge=30]          Frames to keep a lost track before removal
   * @param {number} [options.minHits=1]          Frames a track must be seen before confirmed
   * @param {number} [options.highConfThreshold=0.6]
   * @param {number} [options.lowConfThreshold=0.1]
   * @param {number} [options.iouThreshold=0.3]
   */
  constructor(options = {}) {
    this.minHits          = options.minHits          || 1;
    // highConfThreshold must be ≤ detection confidenceThreshold so new tracks
    // are created for vehicles/accessories which often score 0.25–0.50
    this.highConfThreshold = options.highConfThreshold
      || parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.30');
    this.lowConfThreshold  = options.lowConfThreshold  || 0.1;
    // maxAge and iouThreshold are read from trackerConfig each frame so
    // they can be updated via /api/tracker/config without restarting.
    // options overrides are kept for test compatibility.
    this._maxAgeOverride      = options.maxAge      ?? null;
    this._iouThreshOverride   = options.iouThreshold ?? null;
    this._tracks = [];        // Array of Track
    this._removedTracks = []; // Tracks removed in the last update() call
  }

  /**
   * Returns tracks removed in the most recent update() call, then clears the buffer.
   * Caller (pipelineManager) uses this to persist track lifecycle to DB.
   * @returns {{ id: string, className: string, firstSeenAt: number, confidence: number }[]}
   */
  popRemovedTracks() {
    const removed = this._removedTracks;
    this._removedTracks = [];
    return removed;
  }

  /**
   * Update tracker with new detections from the current frame.
   * @param {Array<{bbox,confidence,classId,className}>} detections
   * @returns {Array<{objectId,bbox,confidence,state}>}
   */
  update(detections) {
    // Read live config so maxAge / iouThreshold changes via API take effect immediately
    const cfg    = trackerConfig.getConfig();
    const maxAge = this._maxAgeOverride  ?? cfg.maxAge      ?? 90;
    this.iouThreshold = this._iouThreshOverride ?? cfg.iouThreshold ?? 0.25;

    // Step 1: Predict all existing tracks
    for (const t of this._tracks) t.predict();

    // Step 2: Separate detections by confidence
    const highConf = detections.filter(d => d.confidence >= this.highConfThreshold);
    const lowConf  = detections.filter(d =>
      d.confidence >= this.lowConfThreshold && d.confidence < this.highConfThreshold
    );

    const activeTracks = this._tracks.filter(t => t.state !== TrackState.Removed);

    // Step 3: Match high-conf detections to active tracks
    const { matched: matchedHigh, unmatchedTracks, unmatchedDets: unmatchedHigh } =
      this._matchDetections(highConf, activeTracks);

    // Step 4: Match low-conf detections to unmatched Lost tracks
    const lostTracks = unmatchedTracks.filter(t => t.state === TrackState.Lost);
    const { matched: matchedLow, unmatchedTracks: stillUnmatched } =
      this._matchDetections(lowConf, lostTracks);

    // Update matched tracks
    for (const [track, det] of matchedHigh) track.update(det);
    for (const [track, det] of matchedLow)  track.update(det);

    // Step 5: Unmatched high-conf → new tracks
    for (const det of unmatchedHigh) {
      this._tracks.push(new Track(det));
    }

    // Step 6: Age out removed tracks (maxAge is now runtime-configurable)
    for (const track of stillUnmatched) {
      if (track.framesWithoutHit > maxAge) {
        track.state = TrackState.Removed;
      }
    }

    // Capture tracks about to be removed so callers can persist lifecycle data
    this._removedTracks = this._tracks.filter(t => t.state === TrackState.Removed);

    // Remove dead tracks
    this._tracks = this._tracks.filter(t => t.state !== TrackState.Removed);

    // Return confirmed tracks (seen at least minHits times, or already tracked)
    return this._tracks
      .filter(t => t.state === TrackState.Tracked && t.hitStreak >= this.minHits)
      .map(t => t.toResult());
  }

  /** Store fast-computed pixel colour on the track (one-frame delayed feedback). */
  updateColor(objectId, color) {
    const track = this._tracks.find(t => t.id === objectId);
    if (track) track.color = color;
  }

  /** Store PAR cloth-type attributes on the track. */
  updateCloth(objectId, cloth) {
    const track = this._tracks.find(t => t.id === objectId);
    if (track && cloth) track.cloth = cloth;
  }

  /** Store PPE accessories (hat/mask boolean) on the track. */
  updateAccessories(objectId, accessories) {
    const track = this._tracks.find(t => t.id === objectId);
    if (track && accessories) track.accessories = accessories;
  }

  /** Store the Age Estimation model's result (Proposed) on the track — mirrors updateColor/updateCloth. */
  updateEstimatedAge(objectId, estimatedAge) {
    const track = this._tracks.find(t => t.id === objectId);
    if (track && estimatedAge) track.estimatedAge = estimatedAge;
  }

  /** Store the Gender Classification model's result (Proposed) on the track — mirrors updateEstimatedAge. */
  updateEstimatedGender(objectId, estimatedGender) {
    const track = this._tracks.find(t => t.id === objectId);
    if (track && estimatedGender) track.estimatedGender = estimatedGender;
  }

  /**
   * Store or update an ArcFace embedding on the track identified by objectId.
   * Called by PipelineManager AFTER enrichment, so embeddings arrive one frame
   * late and are used starting from the following frame's association step.
   *
   * Uses an exponential moving average (α=0.9) to keep the stored embedding
   * stable across minor detection-to-detection variation while still converging
   * quickly to a new appearance when the same track changes appearance.
   *
   * @param {string}     objectId  - Track UUID (from toResult().objectId)
   * @param {Float32Array|Array<number>} embedding - ArcFace 512-dim embedding
   */
  updateAppearance(objectId, embedding) {
    if (!embedding || embedding.length === 0) return;
    const track = this._tracks.find(t => t.id === objectId);
    if (!track) return;

    if (!track.embedding) {
      // First embedding — copy directly
      track.embedding = new Float32Array(embedding);
    } else {
      // Exponential moving average: α=0.9 keeps historical signal, 0.1 blends new
      const alpha = 0.9;
      for (let i = 0; i < embedding.length; i++) {
        track.embedding[i] = alpha * track.embedding[i] + (1 - alpha) * embedding[i];
      }
    }
    track.embeddingAge = 0;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Cosine similarity of two L2-normalised ArcFace embeddings → [−1, 1].
   * For well-normalised ArcFace vectors the effective range is [0, 1].
   */
  static _cosineSim(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  /**
   * RGB colour similarity between two colour descriptors.
   * Uses Euclidean distance in RGB space normalised to [0, 1].
   * Upper and lower body are averaged; unknown channels contribute 0.5 (neutral).
   */
  static _colorSim(a, b) {
    const rgbDist = (r1, r2) => {
      if (!r1 || !r2) return 0.5;
      const dr = r1[0] - r2[0], dg = r1[1] - r2[1], db = r1[2] - r2[2];
      return 1 - Math.min(Math.sqrt(dr*dr + dg*dg + db*db) / 441.67, 1);
    };
    return (rgbDist(a.upperRgb, b.upperRgb) + rgbDist(a.lowerRgb, b.lowerRgb)) / 2;
  }

  /**
   * PAR attribute similarity: exact match on stable identity fields → [0, 1].
   * PA100k (PromptPAR) has no `upper` categorical clothing type (see
   * colorClothService.js _runPAR()), so gender/ageGroup/lower/sleeve are used
   * instead. Fields missing on either side are skipped; if no known fields
   * exist returns 0.5 (neutral).
   */
  static _clothSim(a, b) {
    let score = 0, count = 0;
    for (const field of ['gender', 'ageGroup', 'lower', 'sleeve']) {
      if (a[field] && b[field]) {
        score += a[field] === b[field] ? 1 : 0;
        count++;
      }
    }
    return count > 0 ? score / count : 0.5;
  }

  /**
   * Accessories (hat/mask) presence agreement → [0, 1].
   * Fields missing on either side are skipped; returns 0.5 if no overlap.
   */
  static _accSim(a, b) {
    let score = 0, count = 0;
    for (const field of ['hat', 'mask']) {
      if (a[field] !== undefined && b[field] !== undefined) {
        score += a[field] === b[field] ? 1 : 0;
        count++;
      }
    }
    return count > 0 ? score / count : 0.5;
  }

  _matchDetections(detections, tracks) {
    if (detections.length === 0 || tracks.length === 0) {
      return {
        matched: [],
        unmatchedTracks: [...tracks],
        unmatchedDets: [...detections],
      };
    }

    // ── 5-cue weighted score matrix ───────────────────────────────────────────
    //
    // score(det, track) = Σ(λ_i × sim_i) / Σ(λ_i for active cues)
    //
    // Cue           | sim_i              | Active when
    // --------------|--------------------|-----------------------------------------
    // IoU           | IoU(det, track)    | always
    // Face (ArcFace)| cosine(emb, emb)   | track.embedding set AND det.embedding set
    // Color         | RGB distance [0,1] | track.color set AND det.color set
    // Cloth (PAR)   | exact-match [0,1]  | track.cloth set AND det.cloth set
    // Accessories   | bool agree [0,1]   | track.accessories set AND det.accessories set
    //
    // Dynamic normalisation ensures score ∈ [0, 1] regardless of which cues are
    // available. Class mismatch hard-rejects the pair (score = −1).
    // Weights are runtime-configurable via /api/tracker/config.

    const cfg   = trackerConfig.getConfig();
    const λ_iou   = cfg.iouWeight   ?? 0.60;
    const λ_face  = cfg.faceWeight  ?? 0.20;
    const λ_color = cfg.colorWeight ?? 0.12;
    const λ_cloth = cfg.clothWeight ?? 0.05;
    const λ_acc   = cfg.accWeight   ?? 0.03;

    const scoreMatrix = detections.map(det =>
      tracks.map(track => {
        if (track.className !== det.className) return -1;

        const iouScore = this._iou(det.bbox, track.bbox);

        // Accumulate active cue scores
        let weightedSum = λ_iou * iouScore;
        let totalWeight = λ_iou;

        // Face — ArcFace cosine similarity (embedding age decays confidence)
        if (track.embedding && det.embedding) {
          const faceConf = Math.max(0, 1 - track.embeddingAge * 0.1);
          const w = λ_face * faceConf;
          weightedSum += w * ByteTracker._cosineSim(track.embedding, det.embedding);
          totalWeight += w;
        }

        // Color — fast pixel-average RGB similarity
        if (track.color && det.color) {
          weightedSum += λ_color * ByteTracker._colorSim(track.color, det.color);
          totalWeight += λ_color;
        }

        // Cloth — PAR type exact match
        if (track.cloth && det.cloth) {
          weightedSum += λ_cloth * ByteTracker._clothSim(track.cloth, det.cloth);
          totalWeight += λ_cloth;
        }

        // Accessories — hat/mask presence agreement
        if (track.accessories && det.accessories) {
          weightedSum += λ_acc * ByteTracker._accSim(track.accessories, det.accessories);
          totalWeight += λ_acc;
        }

        return weightedSum / totalWeight;
      })
    );

    const scoreThreshold = this.iouThreshold;

    // Greedy matching (highest score first)
    const usedDets   = new Set();
    const usedTracks = new Set();
    const matched    = [];

    // Collect all (score, detIdx, trackIdx) pairs above threshold, sort descending
    const pairs = [];
    for (let d = 0; d < detections.length; d++)
      for (let t = 0; t < tracks.length; t++)
        if (scoreMatrix[d][t] >= scoreThreshold)
          pairs.push([scoreMatrix[d][t], d, t]);
    pairs.sort((a, b) => b[0] - a[0]);

    for (const [, d, t] of pairs) {
      if (usedDets.has(d) || usedTracks.has(t)) continue;
      matched.push([tracks[t], detections[d]]);
      usedDets.add(d);
      usedTracks.add(t);
    }

    const unmatchedTracks = tracks.filter((_, i) => !usedTracks.has(i));
    const unmatchedDets   = detections.filter((_, i) => !usedDets.has(i));

    return { matched, unmatchedTracks, unmatchedDets };
  }

  _iou(bboxA, bboxB) {
    const ax1 = bboxA.x, ay1 = bboxA.y, ax2 = bboxA.x + bboxA.width,  ay2 = bboxA.y + bboxA.height;
    const bx1 = bboxB.x, by1 = bboxB.y, bx2 = bboxB.x + bboxB.width,  by2 = bboxB.y + bboxB.height;

    // Guard: if any bbox component is NaN/Inf (KF overflow), return 0 so the pair
    // is treated as non-overlapping rather than propagating NaN into the score matrix.
    if (!isFinite(ax1) || !isFinite(ay1) || !isFinite(ax2) || !isFinite(ay2) ||
        !isFinite(bx1) || !isFinite(by1) || !isFinite(bx2) || !isFinite(by2)) {
      console.warn(`[IoU] non-finite bbox: A=${JSON.stringify(bboxA)} B=${JSON.stringify(bboxB)}`);
      return 0;
    }

    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    const iw  = Math.max(0, ix2 - ix1);
    const ih  = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    if (inter === 0) return 0;

    const aArea = bboxA.width * bboxA.height;
    const bArea = bboxB.width * bboxB.height;
    const denom = aArea + bArea - inter;
    if (denom <= 0) return 0;
    return inter / denom;
  }
}

module.exports = { ByteTracker, Track, KalmanFilter, TrackState };
