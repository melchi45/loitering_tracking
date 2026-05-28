'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const sharp = require('sharp');

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
 */
function faceGalleryRouter(db, pipelineManager, getFaceService) {
  const router = Router();

  // ── Galleries CRUD ────────────────────────────────────────────────────────

  // GET /api/galleries  — list all galleries
  router.get('/', (_req, res) => {
    try {
      const galleries = db.all('faceGalleries').sort(
        (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
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
      const gallery = { id: uuidv4(), name: name.trim(), description: description.trim(), type: galleryType };
      db.insert('faceGalleries', gallery);
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
      db.find('faceGalleryFaces', { galleryId: req.params.id })
        .forEach((f) => db.delete('faceGalleryFaces', f.id));
      db.delete('faceGalleries', req.params.id);
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
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
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
      if (!faceService || !faceService.ready) {
        return res.status(503).json({ success: false, error: 'Face service not available — models not loaded' });
      }

      // Normalize to JPEG for consistent processing
      const jpegBuf = await sharp(req.file.buffer).jpeg({ quality: 95 }).toBuffer();
      const { width: origW, height: origH } = await sharp(jpegBuf).metadata();

      // Stage 1: detect face(s)
      const faces = await faceService.detectFaces(jpegBuf, origW, origH);
      if (!faces.length) {
        return res.status(422).json({ success: false, error: 'No face detected in the uploaded photo. Please use a clear frontal face image.' });
      }

      // Pick the largest face (most likely the subject)
      const best = faces.reduce((a, b) =>
        b.bbox.width * b.bbox.height > a.bbox.width * a.bbox.height ? b : a,
      );

      // Stage 2: extract embedding
      const embedding = await faceService.getEmbedding(jpegBuf, best.bbox);
      if (!embedding) {
        return res.status(422).json({ success: false, error: 'Could not extract face embedding. Image quality may be too low.' });
      }

      // Build 64×64 thumbnail (base64 JPEG)
      const { x, y, width, height } = best.bbox;
      const thumbBuf = await sharp(jpegBuf)
        .extract({
          left: Math.max(0, Math.round(x)),
          top:  Math.max(0, Math.round(y)),
          width:  Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height)),
        })
        .resize(64, 64, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();
      const thumbnail = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;

      const face = {
        id:        uuidv4(),
        galleryId: g.id,
        name:      name.trim() || 'Unknown',
        embedding, // 512-D array stored in JSON
        thumbnail,
        bbox:      best.bbox,
        score:     best.score,
      };
      db.insert('faceGalleryFaces', face);

      // Notify pipeline to reload gallery
      if (pipelineManager && typeof pipelineManager.reloadPersistentGallery === 'function') {
        pipelineManager.reloadPersistentGallery();
      }

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
      if (pipelineManager && typeof pipelineManager.reloadPersistentGallery === 'function') {
        pipelineManager.reloadPersistentGallery();
      }
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
      const maxAgeMs = parseInt(req.query.maxAgeMs) || 300_000;
      const data = pipelineManager ? pipelineManager.getPersonTrajectories(maxAgeMs) : [];
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = faceGalleryRouter;
