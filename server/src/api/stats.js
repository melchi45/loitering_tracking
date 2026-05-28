'use strict';

const { Router } = require('express');

/**
 * Stats Dashboard API
 * GET /api/stats/items   — item list for a specific type/date/hour
 *   ?type=detections|alerts|matches|events  (required)
 *   ?date=YYYY-MM-DD                        (required)
 *   ?hour=0-23                              (required)
 * GET /api/stats/hourly  — hourly breakdown by type for a given date
 *   ?date=YYYY-MM-DD (defaults to today)
 * GET /api/stats         — aggregated system statistics
 *
 * @param {import('../db')} db
 * @returns {import('express').Router}
 */
function buildRouter(db) {
  const router = Router();

  /** Extract a JS Date from any common timestamp field */
  function extractTs(record) {
    const raw = record.timestamp || record.createdAt || record.startTime || record.capturedAt;
    if (!raw) return null;
    const d = new Date(typeof raw === 'number' ? raw : raw);
    return isNaN(d.getTime()) ? null : d;
  }

  // ── GET /items ────────────────────────────────────────────────────────────
  router.get('/items', (req, res) => {
    try {
      const TABLE_MAP = {
        detections: 'detectionSnapshots',
        alerts:     'alerts',
        matches:    'faceMatchHistory',
        events:     'events',
      };

      const type = typeof req.query.type === 'string' ? req.query.type : '';
      const dateStr = typeof req.query.date === 'string' ? req.query.date : '';
      const hourRaw = req.query.hour;
      const hourNum = parseInt(hourRaw, 10);

      if (!TABLE_MAP[type]) {
        return res.status(400).json({
          success: false,
          error: `Invalid type "${type}". Must be one of: ${Object.keys(TABLE_MAP).join(', ')}`,
        });
      }
      if (!dateStr) {
        return res.status(400).json({ success: false, error: 'Missing required query param: date' });
      }
      if (isNaN(hourNum) || hourNum < 0 || hourNum > 23) {
        return res.status(400).json({ success: false, error: 'Invalid hour — must be 0-23' });
      }

      const base = new Date(dateStr);
      const dayStart  = new Date(base.getFullYear(), base.getMonth(), base.getDate());
      const hourStart = new Date(dayStart.getTime() + hourNum * 3_600_000);
      const hourEnd   = new Date(hourStart.getTime() + 3_600_000);

      const table = TABLE_MAP[type];
      const items = db.all(table).filter(row => {
        const ts = extractTs(row);
        return ts && ts >= hourStart && ts < hourEnd;
      });

      res.json({
        success: true,
        data: { type, date: dateStr, hour: hourNum, items },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /hourly ───────────────────────────────────────────────────────────
  router.get('/hourly', (req, res) => {
    try {
      const dateStr = typeof req.query.date === 'string' ? req.query.date : null;
      const base    = dateStr ? new Date(dateStr) : new Date();
      const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
      const dayEnd   = new Date(dayStart.getTime() + 86_400_000);

      // 24 zero-filled buckets
      const hours = Array.from({ length: 24 }, (_, h) => ({
        hour:       h,
        detections: 0,
        alerts:     0,
        matches:    0,
        events:     0,
      }));

      const bucket = (table, field) => {
        const rows = db.all(table);
        for (const row of rows) {
          const ts = extractTs(row);
          if (ts && ts >= dayStart && ts < dayEnd) {
            hours[ts.getHours()][field]++;
          }
        }
      };

      bucket('detectionSnapshots', 'detections');
      bucket('alerts',             'alerts');
      bucket('faceMatchHistory',   'matches');
      bucket('events',             'events');

      const summary = hours.reduce(
        (acc, h) => ({
          detections: acc.detections + h.detections,
          alerts:     acc.alerts     + h.alerts,
          matches:    acc.matches    + h.matches,
          events:     acc.events     + h.events,
        }),
        { detections: 0, alerts: 0, matches: 0, events: 0 }
      );

      res.json({
        success: true,
        data: {
          date:    dayStart.toISOString().slice(0, 10),
          hours,
          summary,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET / ─────────────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    try {
      const now = new Date();
      // Today midnight in local time
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // ── Cameras ────────────────────────────────────────────────────────────
      const cameras = db.all('cameras');
      const cameraByStatus = { streaming: 0, stopped: 0, error: 0, connecting: 0 };
      const cameraByType   = { rtsp: 0, youtube: 0 };
      let aiEnabled = 0;

      for (const c of cameras) {
        const s = (c.status || 'stopped').toLowerCase();
        if (s === 'live' || s === 'streaming') {
          cameraByStatus.streaming++;
        } else if (s === 'error') {
          cameraByStatus.error++;
        } else if (s === 'connecting' || s === 'retry') {
          cameraByStatus.connecting++;
        } else {
          cameraByStatus.stopped++;
        }

        if (c.type === 'youtube') cameraByType.youtube++;
        else cameraByType.rtsp++;

        if (c.aiEnabled) aiEnabled++;
      }

      // ── Zones ──────────────────────────────────────────────────────────────
      const zones = db.all('zones');
      const zoneByType = { MONITOR: 0, EXCLUDE: 0 };
      const zoneByCameraMap = {};

      for (const z of zones) {
        const t = (z.type || 'MONITOR').toUpperCase();
        if (t === 'EXCLUDE') zoneByType.EXCLUDE++;
        else zoneByType.MONITOR++;

        if (z.cameraId) {
          zoneByCameraMap[z.cameraId] = (zoneByCameraMap[z.cameraId] || 0) + 1;
        }
      }

      const zoneByCamera = Object.entries(zoneByCameraMap)
        .map(([cameraId, count]) => {
          const cam = cameras.find(c => c.id === cameraId);
          return { cameraId, cameraName: cam ? (cam.name || cameraId) : cameraId, count };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // ── Events ─────────────────────────────────────────────────────────────
      const events = db.all('events');

      // Build 7-day date buckets (oldest first, today last)
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      const dayBuckets = {};
      for (let i = 0; i < 7; i++) {
        const d = new Date(sevenDaysAgo);
        d.setDate(d.getDate() + i);
        dayBuckets[d.toISOString().slice(0, 10)] = 0;
      }

      let eventsToday = 0;
      let eventsLoitering = 0;

      for (const e of events) {
        // Support multiple timestamp field names used across event types
        const raw = e.startTime || e.timestamp || e.createdAt;
        const ts = raw
          ? new Date(typeof raw === 'number' ? raw : raw)
          : null;

        if (ts && !isNaN(ts.getTime())) {
          if (ts >= todayStart) eventsToday++;
          const dayKey = ts.toISOString().slice(0, 10);
          if (dayKey in dayBuckets) dayBuckets[dayKey]++;
        }

        if (
          (typeof e.type === 'string' && e.type.toLowerCase().includes('loiter')) ||
          e.isLoitering === true
        ) {
          eventsLoitering++;
        }
      }

      const last7days = Object.entries(dayBuckets).map(([date, count]) => ({ date, count }));

      // ── Alerts ─────────────────────────────────────────────────────────────
      const alerts = db.all('alerts');
      let alertsToday   = 0;
      let alertsUnack   = 0;
      const alertsBySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 };

      for (const a of alerts) {
        if (a.acknowledged !== true) alertsUnack++;

        const raw = a.timestamp || a.createdAt;
        const ts = raw
          ? new Date(typeof raw === 'number' ? raw : raw)
          : null;
        if (ts && !isNaN(ts.getTime()) && ts >= todayStart) alertsToday++;

        const sev = (a.severity || '').toUpperCase();
        if      (sev === 'HIGH')   alertsBySeverity.HIGH++;
        else if (sev === 'MEDIUM') alertsBySeverity.MEDIUM++;
        else                       alertsBySeverity.LOW++;
      }

      // ── Face ID ────────────────────────────────────────────────────────────
      const galleries = db.all('faceGalleries');
      const faces     = db.all('faceGalleryFaces');

      // ── Storage mode ───────────────────────────────────────────────────────
      const storageMode = process.env.DB_TYPE || 'json';

      res.json({
        success: true,
        data: {
          generatedAt: now.toISOString(),
          storage: { mode: storageMode },
          cameras: {
            total:     cameras.length,
            byStatus:  cameraByStatus,
            byType:    cameraByType,
            aiEnabled,
          },
          zones: {
            total:    zones.length,
            byType:   zoneByType,
            byCamera: zoneByCamera,
          },
          events: {
            total:     events.length,
            today:     eventsToday,
            loitering: eventsLoitering,
            last7days,
          },
          alerts: {
            total:           alerts.length,
            unacknowledged:  alertsUnack,
            today:           alertsToday,
            bySeverity:      alertsBySeverity,
          },
          faces: {
            galleries: galleries.length,
            enrolled:  faces.length,
          },
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
