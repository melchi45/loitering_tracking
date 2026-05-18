'use strict';

const express = require('express');
const { getConfig, setConfig } = require('../services/analyticsConfig');

const router = express.Router();

// GET /api/analytics/config
router.get('/config', (req, res) => {
  res.json({ success: true, data: getConfig() });
});

// PUT /api/analytics/config  { human: true, face: false, ... }
router.put('/config', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, error: 'Body must be an object.' });
  }
  const config = setConfig(updates);
  res.json({ success: true, data: config });
});

module.exports = router;
