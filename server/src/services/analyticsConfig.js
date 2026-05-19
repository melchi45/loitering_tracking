'use strict';

const fs   = require('fs');
const path = require('path');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'storage');

const CONFIG_PATH = path.join(STORAGE_PATH, 'analytics.json');

const DEFAULT_CONFIG = {
  // People / Vehicles (always YOLO)
  human:       false,
  vehicle:     false,
  // Accessories — Phase-1: individual COCO classes (yolov8n, no extra model)
  backpack:    false,
  handbag:     false,
  suitcase:    false,
  umbrella:    false,
  tie:         false,
  // Accessories — Phase-2: worn items (require dedicated model, pending)
  glasses:     false,
  sunglasses:  false,
  // AI attribute modules
  face:        false,
  mask:        false,
  hat:         false,
  color:       false,
  cloth:       false,
  // Hazard detection
  fire:        false,
  smoke:       false,
  // Indoor / office objects (YOLO COCO classes)
  chair:       false,
  couch:       false,
  diningtable: false,
  laptop:      false,
  tv:          false,
  keyboard:    false,
  mouse:       false,
  cellphone:   false,
  clock:       false,
  cup:         false,
  bottle:      false,
  book:        false,
  // Accessories extension — sports & outdoor equipment (COCO yolov8n)
  sportsball:    false,
  frisbee:       false,
  skis:          false,
  snowboard:     false,
  baseballbat:   false,
  baseballglove: false,
  skateboard:    false,
  surfboard:     false,
  tennisracket:  false,
  kite:          false,
  // Personal tools / items (COCO yolov8n)
  remote:        false,
  scissors:      false,
  fork:          false,
  knife:         false,
  spoon:         false,
  // Animals (COCO yolov8n)
  bird:          false,
  cat:           false,
  dog:           false,
  horse:         false,
  sheep:         false,
  cow:           false,
  elephant:      false,
  bear:          false,
  zebra:         false,
  giraffe:       false,
  // Outdoor / Infrastructure (COCO yolov8n)
  bench:         false,
  trafficlight:  false,
  firehydrant:   false,
  stopsign:      false,
  parkingmeter:  false,
  airplane:      false,
  boat:          false,
  train:         false,
  // Food / Kitchen (COCO yolov8n)
  bowl:          false,
  wineglass:     false,
  banana:        false,
  apple:         false,
  sandwich:      false,
  orange:        false,
  broccoli:      false,
  carrot:        false,
  hotdog:        false,
  pizza:         false,
  donut:         false,
  cake:          false,
  // Home Appliances (COCO yolov8n)
  bed:           false,
  toilet:        false,
  sink:          false,
  microwave:     false,
  oven:          false,
  toaster:       false,
  refrigerator:  false,
  pottedplant:   false,
  teddybear:     false,
  hairdrier:     false,
  toothbrush:    false,
};

// COCO class names that belong to each module
const MODULE_CLASSES = {
  human:       ['person'],
  vehicle:     ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  // Individual accessory modules (Phase-1, COCO yolov8n)
  backpack:    ['backpack'],
  handbag:     ['handbag'],
  suitcase:    ['suitcase'],
  umbrella:    ['umbrella'],
  tie:         ['tie'],
  // Phase-2 worn accessories — not yet detectable, kept for future extension
  // glasses / sunglasses: require a dedicated classifier model
  chair:       ['chair'],
  couch:       ['couch'],
  diningtable: ['dining table'],
  laptop:      ['laptop'],
  tv:          ['tv'],
  keyboard:    ['keyboard'],
  mouse:       ['mouse'],
  cellphone:   ['cell phone'],
  clock:       ['clock'],
  cup:         ['cup'],
  bottle:      ['bottle'],
  book:        ['book'],
  // Accessories extension — sports & outdoor equipment
  sportsball:    ['sports ball'],
  frisbee:       ['frisbee'],
  skis:          ['skis'],
  snowboard:     ['snowboard'],
  baseballbat:   ['baseball bat'],
  baseballglove: ['baseball glove'],
  skateboard:    ['skateboard'],
  surfboard:     ['surfboard'],
  tennisracket:  ['tennis racket'],
  kite:          ['kite'],
  // Personal tools / items
  remote:        ['remote'],
  scissors:      ['scissors'],
  fork:          ['fork'],
  knife:         ['knife'],
  spoon:         ['spoon'],
  // Animals
  bird:          ['bird'],
  cat:           ['cat'],
  dog:           ['dog'],
  horse:         ['horse'],
  sheep:         ['sheep'],
  cow:           ['cow'],
  elephant:      ['elephant'],
  bear:          ['bear'],
  zebra:         ['zebra'],
  giraffe:       ['giraffe'],
  // Outdoor / Infrastructure
  bench:         ['bench'],
  trafficlight:  ['traffic light'],
  firehydrant:   ['fire hydrant'],
  stopsign:      ['stop sign'],
  parkingmeter:  ['parking meter'],
  airplane:      ['airplane'],
  boat:          ['boat'],
  train:         ['train'],
  // Food / Kitchen
  bowl:          ['bowl'],
  wineglass:     ['wine glass'],
  banana:        ['banana'],
  apple:         ['apple'],
  sandwich:      ['sandwich'],
  orange:        ['orange'],
  broccoli:      ['broccoli'],
  carrot:        ['carrot'],
  hotdog:        ['hot dog'],
  pizza:         ['pizza'],
  donut:         ['donut'],
  cake:          ['cake'],
  // Home Appliances
  bed:           ['bed'],
  toilet:        ['toilet'],
  sink:          ['sink'],
  microwave:     ['microwave'],
  oven:          ['oven'],
  toaster:       ['toaster'],
  refrigerator:  ['refrigerator'],
  pottedplant:   ['potted plant'],
  teddybear:     ['teddy bear'],
  hairdrier:     ['hair drier'],
  toothbrush:    ['toothbrush'],
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

// Attribute modules that need person detections from YOLO to function
const PERSON_ATTR_MODULES = ['mask', 'hat', 'color', 'cloth', 'face'];

function _anyPersonAttrEnabled() {
  return PERSON_ATTR_MODULES.some(m => _config[m] !== false);
}

/**
 * Returns true if the given COCO class name is allowed by current config.
 * Classes not mapped to any module are always allowed.
 * Person class is also allowed when any attribute module is enabled (mask/hat/color/cloth/face)
 * so that attribute enrichment can run even when the 'human' toggle is off.
 */
function isClassEnabled(className) {
  if (className === 'person' && _anyPersonAttrEnabled()) return true;
  for (const [mod, classes] of Object.entries(MODULE_CLASSES)) {
    if (classes.includes(className)) {
      return _config[mod] !== false;
    }
  }
  return true; // unknown class → allow
}

/**
 * Returns true if at least one YOLO-detectable class module is enabled.
 * Also returns true when attribute modules (mask/hat/color/cloth/face) are enabled,
 * because those need YOLO person detections to run enrichment on.
 */
function anyDetectionEnabled() {
  if (_anyPersonAttrEnabled()) return true;
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
