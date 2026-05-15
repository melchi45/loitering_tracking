'use strict';

const { v4: uuidv4 } = require('uuid');

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
      if (Math.abs(pivot) < 1e-12) continue;
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
  }

  predict() {
    // Use last known position — Kalman prediction removed (NaN instability)
    this.age++;
    this.framesWithoutHit++;
    if (this.framesWithoutHit > 0) this.state = TrackState.Lost;
  }

  update(detection) {
    this.bbox = { ...detection.bbox };
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
    this.maxAge           = options.maxAge           || parseInt(process.env.MAX_TRACK_AGE_FRAMES || '30');
    this.minHits          = options.minHits          || 1;
    this.highConfThreshold = options.highConfThreshold || 0.6;
    this.lowConfThreshold  = options.lowConfThreshold  || 0.1;
    this.iouThreshold     = options.iouThreshold     || 0.3;
    this._tracks = [];  // Array of Track
  }

  /**
   * Update tracker with new detections from the current frame.
   * @param {Array<{bbox,confidence,classId,className}>} detections
   * @returns {Array<{objectId,bbox,confidence,state}>}
   */
  update(detections) {
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

    // Step 6: Age out removed tracks
    for (const track of stillUnmatched) {
      if (track.framesWithoutHit > this.maxAge) {
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

  // ─── Private ──────────────────────────────────────────────────────────────

  _matchDetections(detections, tracks) {
    if (detections.length === 0 || tracks.length === 0) {
      return {
        matched: [],
        unmatchedTracks: [...tracks],
        unmatchedDets: [...detections],
      };
    }

    // Build IoU cost matrix
    const iouMatrix = detections.map(det =>
      tracks.map(track => this._iou(det.bbox, track.bbox))
    );

    // Greedy matching (highest IoU first)
    const usedDets   = new Set();
    const usedTracks = new Set();
    const matched    = [];

    // Collect all (iou, detIdx, trackIdx) pairs and sort descending
    const pairs = [];
    for (let d = 0; d < detections.length; d++)
      for (let t = 0; t < tracks.length; t++)
        if (iouMatrix[d][t] >= this.iouThreshold)
          pairs.push([iouMatrix[d][t], d, t]);
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

    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    const iw  = Math.max(0, ix2 - ix1);
    const ih  = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    if (inter === 0) return 0;

    const aArea = bboxA.width * bboxA.height;
    const bArea = bboxB.width * bboxB.height;
    return inter / (aArea + bArea - inter);
  }
}

module.exports = { ByteTracker, Track, KalmanFilter, TrackState };
