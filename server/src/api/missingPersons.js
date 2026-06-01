'use strict';

const { Router } = require('express');
const missingPersonService = require('../services/missingPersonService');

let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    await missingPersonService.initialize();
    initialized = true;
  }
}

module.exports = function buildMissingPersonsRouter() {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      await ensureInitialized();
      const created = await missingPersonService.registerMissingPerson(req.body || {});
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.get('/', async (req, res) => {
    try {
      await ensureInitialized();
      const criteria = {
        query: req.query.q,
        name: req.query.name,
        age: req.query.age !== undefined ? Number(req.query.age) : undefined,
        gender: req.query.gender,
        status: req.query.status || 'MISSING',
        limit: req.query.limit !== undefined ? Number(req.query.limit) : 10,
      };
      const results = await missingPersonService.searchMissingPerson(criteria);
      res.json({ results, total: results.length });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.get('/detections', async (req, res) => {
    try {
      await ensureInitialized();
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const result = await missingPersonService.getDetectionsByDate(date, {
        missingPersonId: req.query.missingPersonId,
        status: req.query.status,
        cameraId: req.query.cameraId,
        limit: req.query.limit !== undefined ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.put('/:id/status', async (req, res) => {
    try {
      await ensureInitialized();
      const { status, notes } = req.body || {};
      if (!['FOUND', 'MISSING', 'UNCONFIRMED'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be FOUND, MISSING, or UNCONFIRMED' });
      }
      const updated = await missingPersonService.updateMissingPersonStatus(req.params.id, status, notes || null);
      res.json(updated);
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.put('/detections/:id/status', async (req, res) => {
    try {
      await ensureInitialized();
      const { status, confirmedBy } = req.body || {};
      if (!['PENDING', 'CONFIRMED', 'FALSE_POSITIVE'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be PENDING, CONFIRMED, or FALSE_POSITIVE' });
      }
      const updated = await missingPersonService.updateDetectionStatus(req.params.id, status, confirmedBy || null);
      res.json(updated);
    } catch (err) {
      res.status(404).json({ success: false, error: err.message });
    }
  });

  router.get('/stats', async (_req, res) => {
    try {
      await ensureInitialized();
      const stats = await missingPersonService.getStatistics();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
