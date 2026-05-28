'use strict';

/**
 * settings.js — Generic key-value settings REST API
 *
 * All settings are stored in the `settings` table (db.js / MongoDB).
 * Each row: { id: 'settingKey', ...values, createdAt, updatedAt }
 *
 * Endpoints:
 *   GET    /api/settings          → all settings as { key: {...values} }
 *   GET    /api/settings/:key     → single setting values object
 *   PUT    /api/settings/:key     → upsert setting (body = values object)
 *   DELETE /api/settings/:key     → delete setting
 *
 * Covers: analytics, tracker, language, layout, webrtcConfig
 */

const { Router } = require('express');
const { getDB }  = require('../db');

const router = Router();

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', (_req, res) => {
  try {
    const rows = getDB().all('settings');
    const data = {};
    rows.forEach(({ id, createdAt, updatedAt, ...values }) => {
      data[id] = values;
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/settings/:key ────────────────────────────────────────────────────
router.get('/:key', (req, res) => {
  try {
    const row = getDB().findOne('settings', { id: req.params.key });
    if (!row) return res.status(404).json({ success: false, error: 'Setting not found' });
    const { id, createdAt, updatedAt, ...values } = row;
    res.json({ success: true, data: values });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/settings/:key ────────────────────────────────────────────────────
router.put('/:key', (req, res) => {
  try {
    const db  = getDB();
    const key = req.params.key;
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
    }

    const existing = db.findOne('settings', { id: key });
    if (existing) {
      db.update('settings', key, { id: key, ...body });
    } else {
      db.insert('settings', { id: key, ...body });
    }

    const updated = db.findOne('settings', { id: key });
    const { id, createdAt, updatedAt, ...values } = updated;
    res.json({ success: true, data: values });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/settings/:key ─────────────────────────────────────────────────
router.delete('/:key', (req, res) => {
  try {
    const db = getDB();
    const existing = db.findOne('settings', { id: req.params.key });
    if (!existing) return res.status(404).json({ success: false, error: 'Setting not found' });
    db.delete('settings', req.params.key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
