'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sharp = require('sharp');
const AuditService = require('../services/AuditService');
const { extractFaceForEnrollment } = require('../services/faceEnrollHelper');
const faceSearchSync = require('../services/faceSearchSync');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// Multer: memory storage — process buffer directly, no temp files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Only JPEG/PNG/WebP/GIF images are accepted'), { status: 400 }));
  },
});

// Multer error handler — converts LIMIT_FILE_SIZE and fileFilter errors to 400
function multerErrorHandler(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: 'File too large — maximum 10 MB' });
  }
  if (err && err.status === 400) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next(err);
}

/**
 * @param {import('../db').db} db
 * @param {import('../services/pipelineManager')} pipelineManager
 * @param {(() => import('../services/faceService')|null)} getFaceService  Lazy getter — returns null until models load
 * @param {import('../services/analysisClient')|null} [analysisClient]  Dedicated client for enrollment delegation (streaming mode only)
 */
function faceGalleryRouter(db, pipelineManager, getFaceService, analysisClient = null) {
  const router = Router();

  function syncIfStreaming() {
    if (process.env.SERVER_MODE === 'streaming') faceSearchSync.pushReconcile(db, pipelineManager);
  }

  // ── Galleries CRUD ────────────────────────────────────────────────────────

  // GET /api/galleries  — list all galleries
  router.get('/', (_req, res) => {
    try {
      const galleries = db.all('faceGalleries').sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
      );
      const withCount = galleries.map((g) => ({
        ...g,
        faceCount: db.find('faceGalleryFaces', { galleryId: g.id }).length,
      }));
      res.json({ success: true, data: withCount });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/galleries  — create gallery
  router.post('/', (req, res) => {
    try {
      const { name, description = '', type = 'general' } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name is required' });
      const VALID_TYPES = ['general', 'vip', 'blocklist', 'missing'];
      const galleryType = VALID_TYPES.includes(type) ? type : 'general';
      const gallery = { id: uuidv4(), name: name.trim(), description: description.trim(), type: galleryType, source: 'local' };
      db.insert('faceGalleries', gallery);
      AuditService.log({
        event:   'gallery_created',
        actorId: req.user?.sub,
        email:   req.user?.email,
        ip:      clientIp(req),
        detail:  { galleryId: gallery.id, name: gallery.name, type: gallery.type },
      });
      syncIfStreaming();
      res.status(201).json({ success: true, data: { ...gallery, faceCount: 0 } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/galleries/:id  — delete gallery + all its faces
  router.delete('/:id', (req, res) => {
    try {
      const g = db.findOne('faceGalleries', { id: req.params.id });
      if (!g) return res.status(404).json({ success: false, error: 'Gallery not found' });
      const faceCount = db.find('faceGalleryFaces', { galleryId: req.params.id }).length;
      db.find('faceGalleryFaces', { galleryId: req.params.id })
        .forEach((f) => db.delete('faceGalleryFaces', f.id));
      db.delete('faceGalleries', req.params.id);
      AuditService.log({
        event:   'gallery_deleted',
        actorId: req.user?.sub,
        email:   req.user?.email,
        ip:      clientIp(req),
        detail:  { galleryId: g.id, name: g.name, type: g.type, faceCount },
      });
      syncIfStreaming();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Faces CRUD ────────────────────────────────────────────────────────────

  // GET /api/galleries/:id/faces  — list enrolled faces
  router.get('/:id/faces', (req, res) => {
    try {
      const g = db.findOne('faceGalleries', { id: req.params.id });
      if (!g) return res.status(404).json({ success: false, error: 'Gallery not found' });
      const faces = db.find('faceGalleryFaces', { galleryId: req.params.id })
        .map((f) => ({ ...f, embedding: undefined })) // never expose raw embedding
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      res.json({ success: true, data: faces });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/galleries/:id/faces  — upload photo → detect → embed → enroll
  router.post('/:id/faces', upload.single('photo'), multerErrorHandler, async (req, res) => {
    try {
      const g = db.findOne('faceGalleries', { id: req.params.id });
      if (!g) return res.status(404).json({ success: false, error: 'Gallery not found' });
      if (!req.file) return res.status(400).json({ success: false, error: 'photo field is required' });

      const { name = 'Unknown' } = req.body;

      const faceService = typeof getFaceService === 'function' ? getFaceService() : getFaceService;

      let extracted;
      if (faceService && faceService.ready) {
        // Local path — models are loaded on this process (combined/analysis mode).
        try {
          extracted = await extractFaceForEnrollment(faceService, req.file.buffer);
        } catch (err) {
          const status = /No face detected/.test(err.message) || /Could not extract/.test(err.message) ? 422 : 500;
          return res.status(status).json({ success: false, error: err.message });
        }
      } else if (analysisClient) {
        // Delegated path — streaming mode has no local face model; ask the analysis server.
        const jpegBuf = await sharp(req.file.buffer).jpeg({ quality: 95 }).toBuffer();
        const delegated = await analysisClient.extractFaceEmbedding(jpegBuf);
        if (!delegated || !delegated.success) {
          const status = delegated && delegated.status ? delegated.status : 503;
          const error = (delegated && delegated.error) || 'Face service not available — models not loaded';
          return res.status(status).json({ success: false, error });
        }
        extracted = delegated;
      } else {
        return res.status(503).json({ success: false, error: 'Face service not available — models not loaded' });
      }

      const face = {
        id:        uuidv4(),
        galleryId: g.id,
        name:      name.trim() || 'Unknown',
        embedding: extracted.embedding, // 512-D array stored in JSON
        thumbnail: extracted.thumbnail,
        bbox:      extracted.bbox,
        score:     extracted.score,
        source:    'local',
      };
      db.insert('faceGalleryFaces', face);
      AuditService.log({
        event:   'face_enrolled',
        actorId: req.user?.sub,
        email:   req.user?.email,
        ip:      clientIp(req),
        detail:  { galleryId: g.id, galleryType: g.type, faceId: face.id, name: face.name },
      });

      // Notify pipeline to reload gallery
      if (pipelineManager && typeof pipelineManager.reloadPersistentGallery === 'function') {
        pipelineManager.reloadPersistentGallery();
      }
      syncIfStreaming();

      res.status(201).json({
        success: true,
        data: { ...face, embedding: undefined },
      });
    } catch (err) {
      console.error('[FaceGallery] enroll error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/galleries/:id/faces/:faceId  — GDPR right-to-erasure
  router.delete('/:id/faces/:faceId', (req, res) => {
    try {
      const f = db.findOne('faceGalleryFaces', { id: req.params.faceId, galleryId: req.params.id });
      if (!f) return res.status(404).json({ success: false, error: 'Face not found' });
      db.delete('faceGalleryFaces', req.params.faceId);
      AuditService.log({
        event:   'face_deleted',
        actorId: req.user?.sub,
        email:   req.user?.email,
        ip:      clientIp(req),
        detail:  { galleryId: req.params.id, faceId: f.id, name: f.name },
      });
      if (pipelineManager && typeof pipelineManager.reloadPersistentGallery === 'function') {
        pipelineManager.reloadPersistentGallery();
      }
      syncIfStreaming();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Cross-camera stats / trajectories ─────────────────────────────────────

  // GET /api/faces/cross-camera-stats
  router.get('/cross-camera-stats', (_req, res) => {
    try {
      const stats = pipelineManager ? pipelineManager.getCrossCameraReIdStats() : [];
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/faces/trajectories?maxAgeMs=300000
  router.get('/trajectories', (req, res) => {
    try {
      const maxAgeMs = parseInt(req.query.maxAgeMs) || 86_400_000;
      const data = pipelineManager ? pipelineManager.getPersonTrajectories(maxAgeMs) : [];
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/galleries/match-history?limit=50&cameraId=&galleryType=&from=&to=
  router.get('/match-history', (req, res) => {
    try {
      const limit       = Math.min(200, parseInt(req.query.limit) || 50);
      const cameraId    = req.query.cameraId    ? String(req.query.cameraId)    : null;
      const galleryType = req.query.galleryType ? String(req.query.galleryType) : null;
      const fromTs      = req.query.from ? new Date(String(req.query.from)).getTime() : null;
      const toTs        = req.query.to   ? new Date(String(req.query.to)).getTime()   : null;

      let matches = db.all('faceMatchHistory');
      if (cameraId)    matches = matches.filter((m) => m.cameraId === cameraId);
      if (galleryType) matches = matches.filter((m) => m.galleryType === galleryType);
      if (fromTs)      matches = matches.filter((m) => (m.timestamp || 0) >= fromTs);
      if (toTs)        matches = matches.filter((m) => (m.timestamp || 0) <= toTs);

      matches.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      res.json({ success: true, data: matches.slice(0, limit) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = faceGalleryRouter;
