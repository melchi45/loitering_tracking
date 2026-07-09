'use strict';
/**
 * search.js — Global Search API
 *
 * Route:
 *   GET /api/search?q=<query>&types=alerts,detections,faces&from=<ISO>&to=<ISO>
 *     &minConfidence=<0.0–1.0>&maxConfidence=<0.0–1.0>&limit=<n>&offset=<n>
 *
 * Returns unified search results across:
 *   detectionSnapshots  → _type: 'detection'  (includes cropData)
 *   alerts              → _type: 'alert'       (includes cropData when snapshot exists)
 *   faceGalleryFaces    → _type: 'face'        (includes photoData from gallery)
 */

const { Router } = require('express');

const DEFAULT_TYPES = 'alerts,detections,faces,events';
const MAX_LIMIT     = 200;

/**
 * @param {object} db
 * @param {import('../services/qdrantService').QdrantService} [qdrantService]
 *   Optional — enables `types=appearance` (CrossCamera Face Tracking Phase-2, Proposed).
 */
function buildRouter(db, qdrantService = null) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const { q, types = DEFAULT_TYPES, from, to, limit = 30, offset = 0,
              minConfidence, maxConfidence, upperColor, lowerColor } = req.query;

      if (!q || q.trim() === '') {
        return res.status(400).json({ success: false, error: 'q parameter required' });
      }

      // Confidence range parsing (safe fallback to 0 / 1 on NaN)
      const minConf = (minConfidence !== undefined) ? parseFloat(minConfidence) : 0.0;
      const maxConf = (maxConfidence !== undefined) ? parseFloat(maxConfidence) : 1.0;
      const effectiveMinConf = isNaN(minConf) ? 0.0 : Math.max(0.0, Math.min(1.0, minConf));
      const effectiveMaxConf = isNaN(maxConf) ? 1.0 : Math.max(0.0, Math.min(1.0, maxConf));
      if (!isNaN(minConf) && !isNaN(maxConf) && minConf > maxConf) {
        return res.status(400).json({ success: false, error: 'minConfidence must be \u2264 maxConfidence' });
      }

      const lim  = Math.min(parseInt(limit) || 30, MAX_LIMIT);
      const off  = Math.max(parseInt(offset) || 0, 0);
      const ql   = q.trim().toLowerCase();
      const typeSet = new Set(types.split(',').map(t => t.trim()));

      const results = [];

      // ── Detection Snapshots ──────────────────────────────────────────────────
      if (typeSet.has('detections')) {
        let snaps = db.all('detectionSnapshots');

        if (from) snaps = snaps.filter(s => s.timestamp >= from);
        if (to)   snaps = snaps.filter(s => s.timestamp <= to);

        snaps = snaps.filter(s =>
          (s.className  || '').toLowerCase().includes(ql) ||
          (s.cameraName || '').toLowerCase().includes(ql) ||
          (s.zoneName   || '').toLowerCase().includes(ql) ||
          (s.attributes?.face?.name || '').toLowerCase().includes(ql) ||
          (ql === 'loitering' && s.isLoitering === true)
        );

        // Confidence range filter
        if (effectiveMinConf > 0 || effectiveMaxConf < 1) {
          snaps = snaps.filter(s => {
            const c = (s.confidence != null) ? s.confidence : 1.0;
            return c >= effectiveMinConf && c <= effectiveMaxConf;
          });
        }

        // Color pre-filter (FR-CCFR-066, Done) — narrows candidates by clothing
        // color before ranking; distinct from real-time Re-ID weighting (§12.1).
        if (upperColor) {
          const uc = String(upperColor).toLowerCase();
          snaps = snaps.filter(s => (s.attributes?.color?.upper || '').toLowerCase() === uc);
        }
        if (lowerColor) {
          const lc = String(lowerColor).toLowerCase();
          snaps = snaps.filter(s => (s.attributes?.color?.lower || '').toLowerCase() === lc);
        }

        snaps.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

        for (const s of snaps.slice(0, lim)) {
          results.push({
            _type:      'detection',
            id:         s.id,
            cameraId:   s.cameraId,
            cameraName: s.cameraName,
            className:  s.className,
            confidence: s.confidence,
            isLoitering: s.isLoitering,
            dwellTime:  s.dwellTime,
            zoneName:   s.zoneName,
            zoneId:     s.zoneId,
            timestamp:  s.timestamp,
            attributes: s.attributes,
            cropData:   s.cropData,
            // Geometry
            objectId:   s.objectId,
            bbox:       s.bbox,
            frameWidth:  s.frameWidth,
            frameHeight: s.frameHeight,
            cropWidth:   s.cropWidth,
            cropHeight:  s.cropHeight,
            // Behavioral metrics
            velocity:      s.velocity      ?? null,
            riskScore:     s.riskScore     ?? null,
            circularScore: s.circularScore ?? null,
            pacingScore:   s.pacingScore   ?? null,
            revisitCount:  s.revisitCount  ?? null,
          });
        }
      }

      // ── Alerts ───────────────────────────────────────────────────────────────
      if (typeSet.has('alerts')) {
        let alerts = db.all('alerts');

        if (from) alerts = alerts.filter(a => a.timestamp >= from || a.startTime >= from);
        if (to)   alerts = alerts.filter(a => a.timestamp <= to   || a.startTime <= to);

        alerts = alerts.filter(a =>
          (a.type      || '').toLowerCase().includes(ql) ||
          (a.cameraName || a.camera || '').toLowerCase().includes(ql) ||
          (a.zoneName  || a.zone   || '').toLowerCase().includes(ql) ||
          (a.message   || '').toLowerCase().includes(ql)
        );

        alerts.sort((a, b) => {
          const ta = new Date(a.timestamp || a.startTime || 0).getTime();
          const tb = new Date(b.timestamp || b.startTime || 0).getTime();
          return tb - ta;
        });

        // For each alert, try to find a matching snapshot
        const allSnaps = db.all('detectionSnapshots');
        const snapByCam = {};
        for (const s of allSnaps) {
          if (!snapByCam[s.cameraId]) snapByCam[s.cameraId] = [];
          snapByCam[s.cameraId].push(s);
        }

        for (const a of alerts.slice(0, lim)) {
          const ts  = a.timestamp || a.startTime || '';
          const cid = a.cameraId || a.camera;

          // Find closest snapshot within ±5s for this camera
          let cropData = undefined;
          if (cid && snapByCam[cid]) {
            const closest = snapByCam[cid]
              .filter(s => Math.abs(new Date(s.timestamp) - new Date(ts)) <= 5000)
              .sort((a2, b2) =>
                Math.abs(new Date(a2.timestamp) - new Date(ts)) -
                Math.abs(new Date(b2.timestamp) - new Date(ts))
              )[0];
            if (closest) cropData = closest.cropData;
          }

          results.push({
            _type:      'alert',
            id:         a.id,
            type:       a.type,
            cameraId:   cid,
            cameraName: a.cameraName || a.camera,
            zoneName:   a.zoneName   || a.zone,
            dwellTime:  a.dwellTime,
            acknowledged: a.acknowledged,
            timestamp:  ts,
            ...(cropData ? { cropData } : {}),
          });
        }
      }

      // ── Face Gallery Faces ───────────────────────────────────────────────────
      if (typeSet.has('faces')) {
        let faces = db.all('faceGalleryFaces');

        faces = faces.filter(f =>
          (f.name    || '').toLowerCase().includes(ql) ||
          (f.notes   || '').toLowerCase().includes(ql)
        );

        faces.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

        // Get gallery info for type label
        const galleries = db.all('faceGalleries');
        const galleryMap = {};
        for (const g of galleries) galleryMap[g.id] = g;

        for (const f of faces.slice(0, lim)) {
          const gallery = galleryMap[f.galleryId] || {};
          results.push({
            _type:       'face',
            id:          f.id,
            name:        f.name,
            galleryId:   f.galleryId,
            galleryType: gallery.type || gallery.galleryType || 'unknown',
            galleryName: gallery.name || gallery.galleryName,
            notes:       f.notes,
            createdAt:   f.createdAt,
            photoData:   f.photoData || f.faceData,
          });
        }
      }

      // ── Events ───────────────────────────────────────────────────────────────
      if (typeSet.has('events')) {
        let events = db.all('events');

        if (from) events = events.filter(e => (e.timestamp || e.startTime || '') >= from);
        if (to)   events = events.filter(e => (e.timestamp || e.startTime || '') <= to);

        events = events.filter(e =>
          (e.type      || '').toLowerCase().includes(ql) ||
          (e.cameraName || e.camera || '').toLowerCase().includes(ql) ||
          (e.className || '').toLowerCase().includes(ql) ||
          (e.zoneName  || e.zone   || '').toLowerCase().includes(ql) ||
          (e.message   || '').toLowerCase().includes(ql)
        );

        events.sort((a, b) => {
          const ta = new Date(a.timestamp || a.startTime || 0).getTime();
          const tb = new Date(b.timestamp || b.startTime || 0).getTime();
          return tb - ta;
        });

        for (const e of events.slice(0, lim)) {
          results.push({
            _type:      'event',
            id:         e.id,
            type:       e.type,
            cameraId:   e.cameraId || e.camera,
            cameraName: e.cameraName || e.camera,
            className:  e.className,
            zoneName:   e.zoneName || e.zone,
            dwellTime:  e.dwellTime,
            timestamp:  e.timestamp || e.startTime,
          });
        }
      }

      // ── Face Match History ───────────────────────────────────────────────────
      if (typeSet.has('matches')) {
        let history = db.all('faceMatchHistory');

        if (from) history = history.filter(r => (r.createdAt || '') >= from);
        if (to)   history = history.filter(r => (r.createdAt || '') <= to);

        history = history.filter(r =>
          (r.identity    || '').toLowerCase().includes(ql) ||
          (r.galleryType || '').toLowerCase().includes(ql) ||
          (r.cameraId    || '').toLowerCase().includes(ql)
        );

        history.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

        for (const r of history.slice(0, lim)) {
          results.push({
            _type:       'match',
            id:          r.id,
            faceId:      r.faceId,
            cameraId:    r.cameraId,
            identity:    r.identity,
            galleryId:   r.galleryId,
            galleryType: r.galleryType,
            matchScore:  r.matchScore,
            thumbnail:   r.thumbnail,
            liveCropData: r.liveCropData,
            timestamp:   r.timestamp,
            createdAt:   r.createdAt,
          });
        }
      }

      // ── Appearance Re-ID vector search (CrossCamera Face Tracking Phase-2, Proposed) ──
      // Color-filtered listing only (no query-by-example-photo yet) — FR-CCFR-066.
      if (typeSet.has('appearance') && qdrantService?.ready) {
        const must = [];
        if (upperColor) must.push({ key: 'colorUpper', match: { value: String(upperColor).toLowerCase() } });
        if (lowerColor) must.push({ key: 'colorLower', match: { value: String(lowerColor).toLowerCase() } });
        const filter = must.length ? { must } : undefined;
        const points = await qdrantService.scrollAppearanceByFilter(filter, lim);
        for (const p of points) {
          results.push({
            _type:      'appearance',
            id:         p.id,
            cameraId:   p.payload?.cameraId,
            colorUpper: p.payload?.colorUpper,
            colorLower: p.payload?.colorLower,
            timestamp:  p.payload?.timestamp,
          });
        }
      }

      // Sort all results by timestamp/createdAt DESC (handles ISO strings and Unix ms numbers)
      results.sort((a, b) => {
        const ta = new Date(a.timestamp || a.createdAt || 0).getTime();
        const tb = new Date(b.timestamp || b.createdAt || 0).getTime();
        return tb - ta;
      });

      const total = results.length;
      const paged = results.slice(off, off + lim);

      res.json({ query: q, total, results: paged });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
