'use strict';

const express = require('express');
const { getConfig, setConfig, resetConfig } = require('../services/trackerConfig');

const router = express.Router();

// GET /api/tracker/config
router.get('/config', (req, res) => {
  res.json({ success: true, data: getConfig() });
});

// PUT /api/tracker/config  { fastSpeedThreshold: 30, fastQScale: 4.0, ... }
router.put('/config', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, error: 'Body must be a JSON object.' });
  }
  const config = setConfig(updates);
  res.json({ success: true, data: config });
});

// POST /api/tracker/config/reset
router.post('/config/reset', (req, res) => {
  const config = resetConfig();
  res.json({ success: true, data: config });
});

module.exports = router;
