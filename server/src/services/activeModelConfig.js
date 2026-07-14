'use strict';

/**
 * activeModelConfig.js — persists which model is currently "Active" per AI model
 * family (YOLO detector, face-detection, face-recognition, ppe, fire-smoke,
 * cloth-par, human-parsing, appearance-reid, age-estimation, gender-classification)
 * so Admin Dashboard → AI Model Active selections survive a server restart.
 *
 * Storage: `settings` table (row id = 'activeModels'), same DB_TYPE-selected
 * backend (json/mongodb) as trackerConfig.js / analyticsConfig.js. The row is a
 * flat map of `family -> modelId`, so adding a new AI model family later needs
 * no schema change — the map just gains a new key the first time that family's
 * model is switched.
 *
 * Value semantics per family key:
 *   (key absent)  — never configured; family keeps its hardcoded/auto-detected default
 *   modelId       — restore this specific catalog entry at startup
 *   null          — admin explicitly deactivated this family; stay unloaded at startup
 *
 * The YOLO detector catalog entries (server/src/routes/analysisApi.js MODEL_CATALOG)
 * have no `family` field; they're persisted under the fixed key DETECTOR_FAMILY_KEY.
 */

const { getDB } = require('../db');

const SETTING_ID = 'activeModels';
const DETECTOR_FAMILY_KEY = 'yolo-detector';

let _config = null; // lazy-initialised on first access, family -> (modelId|null)

function _getOrInit() {
  if (_config !== null) return _config;

  const db  = getDB();
  const row = db.findOne('settings', { id: SETTING_ID });

  if (row) {
    const { id, createdAt, updatedAt, ...models } = row;
    _config = { ...models };
    return _config;
  }

  _config = {};
  db.insert('settings', { id: SETTING_ID, ..._config });
  return _config;
}

/** Full persisted map: family -> (modelId|null). */
function getActiveModels() {
  return { ..._getOrInit() };
}

/** Record `modelId` as the persisted active selection for `family`. */
function setActiveModel(family, modelId) {
  const key = family || DETECTOR_FAMILY_KEY;
  _getOrInit();
  _config[key] = modelId;

  const db = getDB();
  const existing = db.findOne('settings', { id: SETTING_ID });
  if (existing) {
    db.update('settings', SETTING_ID, { [key]: modelId });
  } else {
    db.insert('settings', { id: SETTING_ID, ..._config });
  }
  return getActiveModels();
}

/** Record `family` as explicitly deactivated (persists `null`, not key removal). */
function clearActiveModel(family) {
  const key = family || DETECTOR_FAMILY_KEY;
  _getOrInit();
  _config[key] = null;

  const db = getDB();
  const existing = db.findOne('settings', { id: SETTING_ID });
  if (existing) {
    db.update('settings', SETTING_ID, { [key]: null });
  } else {
    db.insert('settings', { id: SETTING_ID, ..._config });
  }
  return getActiveModels();
}

module.exports = { getActiveModels, setActiveModel, clearActiveModel, DETECTOR_FAMILY_KEY };
