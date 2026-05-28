'use strict';

/**
 * trackerConfig.js — Kalman-filter tracker algorithm parameters.
 *
 * Storage: `settings` table in db.js (row id = 'tracker').
 * Legacy tracker.json is migrated automatically on first access.
 *
 * All tracker settings persist across server restarts via the shared
 * JSON / MongoDB store controlled by DB_TYPE.
 */

const fs   = require('fs');
const path = require('path');
const { getDB } = require('../db');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'storage');

/** Legacy file path — migrated to DB on first access then no longer written. */
const LEGACY_PATH = path.join(STORAGE_PATH, 'tracker.json');
const SETTING_ID  = 'tracker';

const DEFAULT_CONFIG = {
  // Track lifecycle — controls how long a lost track survives before being removed.
  // Increase maxAge for scenes with frequent occlusion (pillars, crowds, narrow corridors).
  // At 10 FPS: maxAge=90 → 9 seconds, maxAge=30 (old default) → 3 seconds.
  maxAge:             90,   // frames a track survives without a matching detection
  // Minimum IoU score to accept a detection-track association.
  // Lower = more permissive matching (fewer ID switches for jittery detections).
  iouThreshold:       0.25, // minimum combined score to accept a match (was 0.30)

  // Adaptive Q — fast motion
  fastSpeedThreshold: 30,   // px/frame — speed above which track is considered "fast"
  fastQScale:         4.0,  // Q multiplier for fast-moving tracks

  // Adaptive Q — stationary
  slowSpeedThreshold: 5,    // px/frame — speed below which track is considered "stationary"
  slowQScale:         0.5,  // Q multiplier for stationary tracks

  // Adaptive Q — occlusion
  occlusionQScale:    3.0,  // additional Q multiplier when track is occluded (framesWithoutHit > 1)

  // Measurement noise R
  measurementNoise:   10.0, // R diagonal value — higher = trust prediction more, measurements less

  // Multi-cue association weights (IoU + Face + Color + Cloth + Accessories)
  // score = Σ(λ_i × sim_i) / Σ(λ_i for active features)   [0, 1]
  // A feature's weight is included only when BOTH the track AND the detection
  // have that attribute available; otherwise the term is skipped and the
  // remaining weights are re-normalised so the score always stays in [0, 1].
  iouWeight:          0.60, // IoU overlap (always active)
  faceWeight:         0.20, // ArcFace cosine similarity (when face model is on)
  colorWeight:        0.12, // upper/lower body RGB distance (fast pixel avg)
  clothWeight:        0.05, // PAR cloth-type exact match (when openpar.onnx loaded)
  accWeight:          0.03, // hat/mask presence agreement (when PPE model is on)
};

let _config = null; // lazy-initialised on first access

function _getOrInit() {
  if (_config !== null) return _config;

  const db  = getDB();
  const row = db.findOne('settings', { id: SETTING_ID });

  if (row) {
    const { id, createdAt, updatedAt, ...cfg } = row;
    _config = { ...DEFAULT_CONFIG, ...cfg };
    return _config;
  }

  // No DB row yet — try legacy migration
  if (fs.existsSync(LEGACY_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
      _config = { ...DEFAULT_CONFIG, ...saved };
      db.insert('settings', { id: SETTING_ID, ..._config });
      console.log('[trackerConfig] Migrated tracker.json → settings table');
      return _config;
    } catch (_) {}
  }

  // Fresh install — seed defaults
  _config = { ...DEFAULT_CONFIG };
  db.insert('settings', { id: SETTING_ID, ..._config });
  return _config;
}

function getConfig() {
  return { ..._getOrInit() };
}

function setConfig(updates) {
  _getOrInit(); // ensure initialised
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.has(k) && typeof v === 'number' && isFinite(v)) {
      _config[k] = v;
    }
  }

  const db = getDB();
  const existing = db.findOne('settings', { id: SETTING_ID });
  if (existing) {
    db.update('settings', SETTING_ID, { id: SETTING_ID, ..._config });
  } else {
    db.insert('settings', { id: SETTING_ID, ..._config });
  }
  return getConfig();
}

function resetConfig() {
  _config = { ...DEFAULT_CONFIG };

  const db = getDB();
  const existing = db.findOne('settings', { id: SETTING_ID });
  if (existing) {
    db.update('settings', SETTING_ID, { id: SETTING_ID, ..._config });
  } else {
    db.insert('settings', { id: SETTING_ID, ..._config });
  }
  return getConfig();
}

module.exports = { getConfig, setConfig, resetConfig, DEFAULT_CONFIG };
