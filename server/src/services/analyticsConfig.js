'use strict';

const fs   = require('fs');
const path = require('path');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'storage');

const CONFIG_PATH = path.join(STORAGE_PATH, 'analytics.json');

const DEFAULT_CONFIG = {
  // People / Vehicles (always YOLO)
  human:       true,
  vehicle:     true,
  accessories: true,
  // AI attribute modules
  face:        true,
  mask:        true,
  hat:         true,
  color:       true,
  cloth:       true,
  // Hazard detection
  fire:        true,
  smoke:       true,
  // Indoor / office objects (YOLO COCO classes)
  chair:       true,
  couch:       true,
  diningtable: true,
  laptop:      true,
  tv:          true,
  keyboard:    true,
  mouse:       true,
  cellphone:   true,
  clock:       true,
  cup:         true,
  bottle:      true,
  book:        true,
};

// COCO class names that belong to each module
const MODULE_CLASSES = {
  human:       ['person'],
  vehicle:     ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'],
  chair:       ['chair'],
  couch:       ['couch'],
  diningtable: ['dining table'],
  laptop:      ['laptop'],
  tv:          ['tv'],
  keyboard:    ['keyboard'],
  mouse:       ['mouse'],
  cellphone:   ['cell phone'],
  clock:       ['clock'],
  cup:         ['cup', 'wine glass'],
  bottle:      ['bottle'],
  book:        ['book'],
};

let _config = { ...DEFAULT_CONFIG };

function _load() {
  if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      _config = { ...DEFAULT_CONFIG, ...saved };
    } catch (_) {}
  }
}

function _save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}

_load();

function getConfig() {
  return { ..._config };
}

function setConfig(partial) {
  _config = { ...DEFAULT_CONFIG, ..._config, ...partial };
  _save();
  return getConfig();
}

function isEnabled(moduleId) {
  return _config[moduleId] !== false;
}

/**
 * Returns true if the given COCO class name is allowed by current config.
 * Classes not mapped to any module are always allowed.
 */
function isClassEnabled(className) {
  for (const [mod, classes] of Object.entries(MODULE_CLASSES)) {
    if (classes.includes(className)) {
      return _config[mod] !== false;
    }
  }
  return true; // unknown class → allow
}

/**
 * Returns true if at least one YOLO-detectable class module is enabled.
 * When false, running YOLO inference produces no useful output — skip it.
 */
function anyDetectionEnabled() {
  for (const mod of Object.keys(MODULE_CLASSES)) {
    if (_config[mod] !== false) return true;
  }
  return false;
}

/**
 * Returns true if ANY analytics module is enabled (YOLO classes + attribute + fire/smoke).
 * When false, the entire inference path (tracker, behavior, attributes) can be skipped.
 */
function anyModuleEnabled() {
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (_config[key] !== false) return true;
  }
  return false;
}

module.exports = { getConfig, setConfig, isEnabled, isClassEnabled, anyDetectionEnabled, anyModuleEnabled, DEFAULT_CONFIG };
