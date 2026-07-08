'use strict';

const sharp = require('sharp');

/**
 * Detect the largest face in a photo, extract its embedding, and crop a 64×64 thumbnail.
 * Shared by the local gallery-enrollment path (faceGallery.js) and the analysis server's
 * delegated enrollment endpoint (POST /api/analysis/face-embed) so both produce identical
 * bbox/score/embedding/thumbnail output from the same detect→embed→crop logic.
 *
 * @param {import('./faceService')} faceService
 * @param {Buffer} rawImageBuffer
 * @returns {Promise<{ bbox: object, score: number, embedding: number[], thumbnail: string }>}
 * @throws {Error} 'No face detected...' or 'Could not extract face embedding...'
 */
async function extractFaceForEnrollment(faceService, rawImageBuffer) {
  const jpegBuf = await sharp(rawImageBuffer).jpeg({ quality: 95 }).toBuffer();
  const { width: origW, height: origH } = await sharp(jpegBuf).metadata();

  const faces = await faceService.detectFaces(jpegBuf, origW, origH);
  if (!faces.length) {
    throw new Error('No face detected in the uploaded photo. Please use a clear frontal face image.');
  }

  const best = faces.reduce((a, b) =>
    b.bbox.width * b.bbox.height > a.bbox.width * a.bbox.height ? b : a,
  );

  const embedding = await faceService.getEmbedding(jpegBuf, best.bbox);
  if (!embedding) {
    throw new Error('Could not extract face embedding. Image quality may be too low.');
  }

  const { x, y, width, height } = best.bbox;
  const thumbBuf = await sharp(jpegBuf)
    .extract({
      left:   Math.max(0, Math.round(x)),
      top:    Math.max(0, Math.round(y)),
      width:  Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    })
    .resize(64, 64, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();
  const thumbnail = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;

  return { bbox: best.bbox, score: best.score, embedding, thumbnail };
}

module.exports = { extractFaceForEnrollment };
