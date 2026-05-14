'use strict';

const { Router } = require('express');

/**
 * @param {import('../services/zoneManager')} zoneManager
 * @returns {Router}
 */
function zonesRouter(zoneManager) {
  // Nested under /api/cameras/:cameraId/zones
  const router = Router({ mergeParams: true });

  /**
   * GET /api/cameras/:cameraId/zones
   * List all zones for a camera.
   */
  router.get('/', (req, res) => {
    try {
      const zones = zoneManager.getZonesForCamera(req.params.cameraId);
      res.json({ success: true, data: zones });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:cameraId/zones
   * Create a new zone.
   * Body: { name, polygon, type?, dwellThreshold?, minDisplacement?, reentryWindow?, schedule? }
   */
  router.post('/', (req, res) => {
    try {
      const { cameraId } = req.params;
      const { name, polygon, type, dwellThreshold, minDisplacement, reentryWindow, schedule } = req.body;

      if (!name || !polygon || !Array.isArray(polygon) || polygon.length < 3) {
        return res.status(400).json({
          success: false,
          error:   'name and polygon (array of ≥3 {x,y} points) are required',
        });
      }

      if (type && !['MONITOR', 'EXCLUDE'].includes(type)) {
        return res.status(400).json({ success: false, error: 'type must be MONITOR or EXCLUDE' });
      }

      const zone = zoneManager.addZone(cameraId, {
        name, polygon, type, dwellThreshold, minDisplacement, reentryWindow, schedule,
      });
      res.status(201).json({ success: true, data: zone });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /api/cameras/:cameraId/zones/:id
   * Update an existing zone.
   */
  router.put('/:id', (req, res) => {
    try {
      const updated = zoneManager.updateZone(req.params.id, req.body);
      if (!updated) return res.status(404).json({ success: false, error: 'Zone not found' });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * DELETE /api/cameras/:cameraId/zones/:id
   * Remove a zone.
   */
  router.delete('/:id', (req, res) => {
    try {
      const deleted = zoneManager.deleteZone(req.params.id);
      if (!deleted) return res.status(404).json({ success: false, error: 'Zone not found' });
      res.json({ success: true, message: 'Zone deleted' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = zonesRouter;
