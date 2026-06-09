'use strict';

/**
 * analyticsConfig.js — Analytics module toggle configuration.
 *
 * Storage: `settings` table in db.js (row id = 'analytics').
 * Legacy analytics.json is migrated automatically on first access.
 *
 * All analytics settings (human, vehicle, face, mask, hat, …) persist across
 * server restarts via the shared JSON / MongoDB store controlled by DB_TYPE.
 */

const fs   = require('fs');
const path = require('path');
const { getDB } = require('../db');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'storage');

/** Legacy file path — migrated to DB on first access then no longer written. */
const LEGACY_PATH = path.join(STORAGE_PATH, 'analytics.json');
const SETTING_ID  = 'analytics';

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

let _config = null; // lazy-initialised on first access

/**
 * Load config from DB settings table.
 * On first call: migrates legacy analytics.json if present.
 * Thread-safe for Node.js single-threaded event loop.
 */
function _getOrInit() {
  if (_config !== null) return _config;

  const db  = getDB();
  const row = db.findOne('settings', { id: SETTING_ID });

  if (row) {
    const { id, createdAt, updatedAt, ...cfg } = row;
    // Only copy keys defined in DEFAULT_CONFIG — purges stale/test keys on read.
    const clean = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) clean[key] = cfg[key] ?? false;
    _config = { ...DEFAULT_CONFIG, ...clean };
    return _config;
  }

  // No DB row yet — try legacy migration
  if (fs.existsSync(LEGACY_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
      // Filter unknown keys from legacy file too
      const clean = {};
      for (const key of Object.keys(DEFAULT_CONFIG)) clean[key] = saved[key] ?? false;
      _config = { ...DEFAULT_CONFIG, ...clean };
      db.insert('settings', { id: SETTING_ID, ..._config });
      console.log('[analyticsConfig] Migrated analytics.json → settings table');
      return _config;
    } catch (_) {}
  }

  // Fresh install — seed defaults
  _config = { ...DEFAULT_CONFIG };
  db.insert('settings', { id: SETTING_ID, ..._config });
  return _config;
}

function getConfig() {
  const cfg = _getOrInit();
  // Only expose keys defined in DEFAULT_CONFIG — unknown keys from stale DB
  // rows or test entries must not leak into the API response or module list.
  const clean = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) clean[key] = cfg[key] ?? false;
  return clean;
}

function setConfig(partial) {
  _getOrInit(); // ensure initialised
  // Silently drop any key not in DEFAULT_CONFIG so test / typo keys never
  // enter the DB or appear in the enabled-modules list.
  const sanitised = {};
  for (const key of Object.keys(partial)) {
    if (key in DEFAULT_CONFIG) sanitised[key] = partial[key];
  }
  // Rebuild from DEFAULT_CONFIG baseline — never spread unknown keys from _config.
  const base = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) base[key] = _config[key] ?? DEFAULT_CONFIG[key];
  _config = { ...base, ...sanitised };

  const db = getDB();
  // Write only known keys to the DB row to purge any previously stored garbage.
  const row = { id: SETTING_ID };
  for (const key of Object.keys(DEFAULT_CONFIG)) row[key] = _config[key];

  const existing = db.findOne('settings', { id: SETTING_ID });
  if (existing) {
    db.update('settings', SETTING_ID, row);
  } else {
    db.insert('settings', row);
  }
  return { ..._config };
}

function isEnabled(moduleId) {
  const cfg = _getOrInit();
  // Unknown modules (not in DEFAULT_CONFIG) are always disabled — prevents
  // stale DB keys or test keys from accidentally enabling processing.
  if (!(moduleId in DEFAULT_CONFIG)) return false;
  return cfg[moduleId] !== false;
}

// Attribute modules that need person detections from YOLO to function
const PERSON_ATTR_MODULES = ['mask', 'hat', 'color', 'cloth', 'face'];

function _anyPersonAttrEnabled() {
  const cfg = _getOrInit();
  return PERSON_ATTR_MODULES.some(m => cfg[m] !== false);
}

/**
 * Returns true if the given COCO class name is allowed by current config.
 * Classes not mapped to any module are always allowed.
 * Person class is also allowed when any attribute module is enabled (mask/hat/color/cloth/face)
 * so that attribute enrichment can run even when the 'human' toggle is off.
 */
function isClassEnabled(className) {
  if (className === 'person' && _anyPersonAttrEnabled()) return true;
  const cfg = _getOrInit();
  for (const [mod, classes] of Object.entries(MODULE_CLASSES)) {
    if (classes.includes(className)) {
      return cfg[mod] !== false;
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
  const cfg = _getOrInit();
  for (const mod of Object.keys(MODULE_CLASSES)) {
    if (cfg[mod] !== false) return true;
  }
  return false;
}

/**
 * Returns true if ANY analytics module is enabled (YOLO classes + attribute + fire/smoke).
 * When false, the entire inference path (tracker, behavior, attributes) can be skipped.
 */
function anyModuleEnabled() {
  const cfg = _getOrInit();
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (cfg[key] !== false) return true;
  }
  return false;
}

module.exports = { getConfig, setConfig, isEnabled, isClassEnabled, anyDetectionEnabled, anyModuleEnabled, DEFAULT_CONFIG };
