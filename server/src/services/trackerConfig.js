'use strict';

const fs   = require('fs');
const path = require('path');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'storage');

const CONFIG_PATH = path.join(STORAGE_PATH, 'tracker.json');

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

  // Multi-cue association weights (IoU + ArcFace appearance)
  // cost = iouWeight × (1−IoU) + appWeight × (1−cosineSim)
  // appWeight is only active when the track has a stored ArcFace embedding;
  // otherwise the matcher falls back to pure IoU (appWeight effectively = 0).
  iouWeight:          0.7,  // weight of IoU cost term (0.0–1.0)
  appWeight:          0.3,  // weight of appearance (cosine) cost term (0.0–1.0)
};

let _config = { ...DEFAULT_CONFIG };

function _load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      _config = { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (_) {}
}

function _save() {
  try {
    if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
  } catch (_) {}
}

_load();

function getConfig() {
  return { ..._config };
}

function setConfig(updates) {
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.has(k) && typeof v === 'number' && isFinite(v)) {
      _config[k] = v;
    }
  }
  _save();
  return getConfig();
}

function resetConfig() {
  _config = { ...DEFAULT_CONFIG };
  _save();
  return getConfig();
}

module.exports = { getConfig, setConfig, resetConfig, DEFAULT_CONFIG };
