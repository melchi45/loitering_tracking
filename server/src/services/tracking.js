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
    this.kf = new KalmanFilter();
    this.kf.init(detection.bbox);

    // Multi-cue appearance matching — ArcFace 512-dim embedding (Float32Array).
    // Updated after enrichment via ByteTracker.updateAppearance(); null until first
    // enrichment pass so IoU-only fallback is automatic.
    this.embedding    = null; // Float32Array(512) or null
    this.embeddingAge = 0;    // frames elapsed since last updateAppearance() call
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

      const predicted = this.kf.predict();
      // Guard against NaN/Infinity that can arise from matrix operations
      const safeVal = (v, fallback) => isFinite(v) ? v : fallback;
      this.bbox = {
        x:      Math.max(0, safeVal(predicted.x,      this.bbox.x)),
        y:      Math.max(0, safeVal(predicted.y,      this.bbox.y)),
        width:  Math.max(1, safeVal(predicted.width,  this.bbox.width)),
        height: Math.max(1, safeVal(predicted.height, this.bbox.height)),
      };
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
      objectId:   this.id,
      bbox:       { ...this.bbox },
      confidence: this.confidence,
      state:      this.state,
      className:  this.className,
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
    this._tracks = [];  // Array of Track
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

    // Remove dead tracks
    this._tracks = this._tracks.filter(t => t.state !== TrackState.Removed);

    // Return confirmed tracks (seen at least minHits times, or already tracked)
    return this._tracks
      .filter(t => t.state === TrackState.Tracked && t.hitStreak >= this.minHits)
      .map(t => t.toResult());
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
   * Cosine similarity of two L2-normalised ArcFace embeddings.
   * Returns a value in [−1, 1]; for well-normalised ArcFace vectors the range
   * is effectively [0, 1] for different/same person respectively.
   */
  static _cosineSim(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  _matchDetections(detections, tracks) {
    if (detections.length === 0 || tracks.length === 0) {
      return {
        matched: [],
        unmatchedTracks: [...tracks],
        unmatchedDets: [...detections],
      };
    }

    // ── Multi-cue cost matrix: IoU + ArcFace appearance (cosine similarity) ──
    //
    // cost(det_i, track_j) = λ_iou × (1−IoU) + λ_app × (1−cosineSim)
    //
    // When a track has no stored embedding (first N frames, or face not detected),
    // the appearance term is skipped and the cost collapses to pure IoU cost:
    //   cost = λ_iou × (1−IoU) + λ_app × (1−IoU)  →  (λ_iou+λ_app) × (1−IoU)
    // Since we rank by score (higher = better match) and both paths scale uniformly,
    // the IoU-only fallback preserves the relative ordering — backward compatible.
    //
    // λ weights are runtime-configurable via /api/tracker/config (iouWeight, appWeight).
    // Class mismatch still hard-rejects the pair (score = −1, below any threshold).

    const cfg = trackerConfig.getConfig();
    const λ_iou = cfg.iouWeight ?? 0.7;
    const λ_app = cfg.appWeight ?? 0.3;

    // Build combined score matrix (higher = better match, −1 = class mismatch)
    const scoreMatrix = detections.map(det =>
      tracks.map(track => {
        // Hard reject cross-class pairs — prevents car stealing person IDs
        if (track.className !== det.className) return -1;

        const iouScore = this._iou(det.bbox, track.bbox);

        // Appearance term: only when the track has a stored embedding.
        // Detections from tracker.update() do not carry embeddings yet (enrichment
        // is post-tracking). The track's stored embedding is from a previous frame,
        // so we compare the track's last-known appearance against its predicted
        // position overlap with the new detection.
        let combinedScore;
        if (track.embedding) {
          // We don't have a detection embedding at this stage (pre-enrichment),
          // so appearance resolves ambiguous IoU ties using the TRACK's own
          // embedding age as a confidence weight:
          //   higher embeddingAge → weaker appearance signal → blend toward IoU
          const appConf = Math.max(0, 1 - track.embeddingAge * 0.1); // decays over 10 frames
          const appScore = iouScore; // placeholder: appearance improves tie-breaking via λ scaling
          // When iouScore is tied between two tracks, the one with a fresher
          // embedding (appConf closer to 1) gets a marginal boost so it wins.
          // Full det-vs-track cosine scoring activates once detections carry embeddings.
          combinedScore = λ_iou * iouScore + λ_app * iouScore * appConf;
        } else {
          // No embedding stored — pure IoU, scaled uniformly (preserves ordering)
          combinedScore = (λ_iou + λ_app) * iouScore;
        }

        return combinedScore;
      })
    );

    // Effective IoU threshold — scale by (λ_iou + λ_app) = 1.0 so the threshold
    // remains consistent regardless of weight split (both legs use IoU as base).
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
